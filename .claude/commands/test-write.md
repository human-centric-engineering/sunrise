---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Execute a test plan by spawning test-engineer subagents to create, add, and rewrite tests
---

Execute a test plan by spawning test-engineer subagents. This command is a **plan executor** — it expects a plan from `/test-plan` (or generates a minimal one inline for trivially small scopes).

For each file in the plan, the agent handles whichever combination is needed:

- **Create**: No test file exists → write from scratch
- **Add**: Test file exists but missing test cases → add new cases
- **Rewrite**: Test file exists with quality issues → rewrite weak tests while preserving good ones

**Important:** This command spawns test-engineer agents in the **foreground** (never background) — they need Write/Edit tool access.

## Input

$ARGUMENTS — controls what to execute:

- **`plan`** → execute the plan from `.claude/tmp/test-plan.md` (Sprint 1 by default)
- **`plan sprint N`** → execute a specific sprint from the plan file
- **`plan all`** → execute all sprints sequentially from the plan file
- **File paths (1-2 files only)** → generate a minimal inline plan and execute it immediately (skip `/test-plan` for trivial scope)
- **No arguments** → if `.claude/tmp/test-plan.md` exists, use it (Sprint 1); otherwise prompt the user to run `/test-plan` first

**Plan source:** The plan file at `.claude/tmp/test-plan.md` is the single source of truth. It is overwritten by each `/test-plan` run.

## Steps

### Step 1: Resolve the plan

**If `plan` keyword is present (or no arguments):**

- Read `.claude/tmp/test-plan.md` and follow the reader protocol in `.claude/docs/test-command-file-protocol.md`:
  1. Parse the frontmatter metadata.
  2. Hard-stop if an invocation scope disagrees with the file's scope. (For `/test-write`, no scope is ever passed as an argument, so this step just verifies the file parses.)
  3. Soft-warn on age >1h, branch change, or HEAD change. Given that `/test-write` executes work from the plan, a stale plan is riskier than a stale review — if age >24h OR branch/HEAD changed, pause and ask the user to confirm before proceeding.
  4. Print the provenance line.
- If `sprint N` is specified, extract only that sprint's batches.
- If `all` is specified, execute all sprints in order.
- If neither, default to Sprint 1.
- If the file does not exist, report: "No test plan found at `.claude/tmp/test-plan.md`. Run `/test-plan` first to create one." and stop.

### Step 1.5: Enforce Source Decisions (hard stop on pending)

After the plan parses, inspect the `## Source Decisions` block (if present).

- If the block is absent or empty, continue.
- Parse every finding's `**Status**` field. Valid terminal values: `resolved` (Fix landed) or `accepted` (user confirmed Document or Skip).
- If ANY finding has `Status: pending`, STOP and tell the user:

  > `{count}` Source Decision{s} in `.claude/tmp/test-plan.md` {is/are} still `pending`. `/test-write` refuses to execute until each is resolved (source fix merged) or accepted (user explicitly confirmed `Document` or `Skip`).
  >
  > Pending findings:
  >
  > - `{source path}:{line}` — {summary} (Decision: {decision})
  >   {...one per pending finding}
  >
  > To unblock:
  >
  > - **Fix**: land the source change, then edit `.claude/tmp/test-plan.md` and set `Status: resolved` for that finding.
  > - **Document / Skip**: re-read the reasoning, confirm you want to accept it, then edit the file and set `Status: accepted` (and update `Decision:` if you're overriding the default).

  Do not proceed. Do not offer to patch statuses yourself — the status flip is the user's explicit authorization for the sprint to run.

- If every finding is `resolved` or `accepted`, print a one-line confirmation before moving on:

  ```
  Source Decisions: {R} resolved, {A} accepted — OK to execute.
  ```

**If 1-2 file paths are provided (no `plan` keyword):**

- This is a trivially small scope — generate a minimal plan inline:
  - Read each source file
  - Check for existing test files and read them if present
  - Classify each existing test as keep/rewrite, identify missing tests
  - Determine mocking requirements
  - Create a single-batch plan
- Confirm with the user before executing

**If 3+ file paths are provided:**

- Report: "For 3+ files, run `/test-plan {paths}` first to create a structured plan, then `/test-write plan` to execute it." and stop.

**If no arguments and no plan in conversation:**

- Report: "No plan found. Run one of these first:" and list:
  - `/test-plan` — plan tests for branch changes
  - `/test-plan {folder}` — plan tests for a specific folder
  - `/test-plan coverage` — plan from coverage analysis
  - `/test-plan review` — plan from quality review findings

### Step 2: Present execution summary and confirm

Before spawning any agents, show the user what will happen:

```
## Execution Plan

**Sprint**: {sprint number and name}
**Files**: {count}
**Agent batches**: {count}
**Estimated agents to spawn**: {count}
**Source Decisions**: {R} resolved, {A} accepted (0 pending — verified in Step 1.5)

| Batch | Files | Action | Agent Scope |
|-------|-------|--------|-------------|
| 1.1 | 3 | CREATE (2), UPDATE (1) | Validation schemas — simple, no mocking |
| 1.2 | 1 | UPDATE | Auth guards — complex, auth + db mocking |

{If any decisions were `accepted` with `Document` or `Skip`, list them briefly so the user can spot a mistake before agents start:}
**Accepted decisions** (source not changed — tests will assert current behavior):
- `{source path}:{line}` — Document: {what the test will assert instead}
- `{source path}:{line}` — Skip: {which test(s) are being deleted}

Proceed? (Y/n)
```

Wait for user confirmation before spawning agents. If the user wants to adjust, they should modify the plan and re-run.

### Step 3: Execute agent batches sequentially

For each batch in the sprint, spawn a **foreground** test-engineer agent. The prompt must include:

1. **The per-file work instructions** from the plan (keep/rewrite/add details for each file)

2. **Test quality guidance:**

> **Test quality requirements:**
>
> - Every test must follow AAA (Arrange-Act-Assert) pattern
> - Test the code's INTENT and CONTRACT, not just its current output
> - For **Keep** tests: do not modify these — they are already good
> - For **Rewrite** tests: preserve the scenario being tested but fix the assertions/approach. The rewritten test should fail if the code's behavior regresses.
> - For **Add** tests: write new test cases for the listed scenarios. Each should test ONE specific behavior.
> - Use shared mock factories from `tests/types/mocks.ts`
> - Use type-safe assertions from `tests/helpers/assertions.ts`
> - When a test fails: determine if the code or the test is wrong before fixing (see "When Tests Fail" in agent definition)
> - Read `.claude/skills/testing/gotchas.md` before writing any tests

3. **Mid-sprint source-bug protocol:**

> If, while writing a test, you discover a **new** suspected source bug that is NOT already covered by a Source Decision in the plan (e.g. a rewritten assertion against the honest contract fails because the source is broken), you MUST:
>
> 1. STOP work on that file. Do not modify the source. Do not weaken the test to make it pass.
> 2. Report the finding in your final output under a `## New Source Findings` heading with:
>    - `source file:line` — one-line summary
>    - linked test (file + intended test name)
>    - concrete evidence (assertion run, actual vs expected, stack if relevant)
>    - recommended classification (default: **Fix**)
> 3. Leave the file in a clean state — either revert the rewrite-in-progress or mark the failing test with `it.todo(...)` and a `// MID-SPRINT FINDING: see sprint output` comment. Never commit a green test that hides the finding.
> 4. Continue to the next file in your batch (other files are not blocked by one file's finding).

4. **Validation requirements:**

> After completing all changes:
>
> 1. Run `npm test -- {test file paths}` — all must pass (tests parked with `it.todo` due to mid-sprint findings count as a known gap, not a failure)
> 2. Run `npm run lint` — no new errors
> 3. Run `npm run type-check` — no new errors
> 4. Run `npm run format:check` — must be clean. If it fails, run `npx prettier --write {edited paths}` and re-verify.
>    Do NOT mark complete until all four pass.

### Step 4: Report batch results

After each agent completes, report:

```
### Batch {N} Results

| File | Test File | Action | Kept | Rewritten | Added | Todo | Total | Pass | Status |
|------|-----------|--------|------|-----------|-------|------|-------|------|--------|
| `lib/auth/guards.ts` | `tests/unit/lib/auth/guards.test.ts` | UPDATE | 4 | 2 | 3 | 0 | 9 | 9/9 | DONE |
| `lib/api/client.ts` | `tests/unit/lib/api/client.test.ts` | CREATE | — | — | 12 | 0 | 12 | 12/12 | DONE |

{Any issues encountered. If the agent reported mid-sprint findings, add them to the running `New Source Findings` list — see Step 4.5.}
```

The `Todo` column counts tests parked with `it.todo(...)` because of a mid-sprint source finding — those are known gaps, not regressions, but they must be resolved before the sprint can be considered complete.

### Step 4.5: Collect mid-sprint source findings

Maintain a running list of any `## New Source Findings` sections returned by agents during the sprint. After each batch, append new findings to the list and print:

```
### New Source Findings (sprint so far: {count})

- `{source path}:{line}` — {summary}
  - Linked test: `{test path}` — `{test name}` (parked as `it.todo`)
  - Evidence: {one-line summary of assertion + actual behavior}
  - Recommended classification: Fix | Document | Skip (default: **Fix**)
```

Do NOT halt the whole sprint on the first finding — other batches may not be affected, and running them in parallel keeps the user's time to decision short. But do NOT proceed to Step 5's "sprint complete" claim while findings are unresolved.

### Step 5: Sprint summary

After all batches in the sprint complete. The sprint is considered **Complete** only if zero mid-sprint findings are open; otherwise it's **Complete with open findings** and the next step is decision-making, not the next sprint.

```
## Sprint {N} {Complete | Complete with open findings}: {name}

**Files processed**: {count}
- Created: {count} new test files
- Updated: {count} existing test files ({rewritten} tests rewritten, {added} tests added, {kept} tests kept)
**Total tests**: {count} ({todo} parked as `it.todo` pending source decision)
**All passing**: Yes / No (excluding `it.todo`)

### Coverage Impact
| File | Before | After | Target | Status |
|------|--------|-------|--------|--------|
{per-file coverage changes — run `npm run test:coverage` to get updated numbers}

### Source Decisions from the plan
{Quick audit — confirm each Source Decision was actually honored:}
- `{source path}:{line}` — Decision: Fix → source change landed: Yes / No
- `{source path}:{line}` — Decision: Document → test asserts honest current behavior: Yes / No
- `{source path}:{line}` — Decision: Skip → test was deleted / not replaced: Yes / No

{If any row is "No", flag as a regression — the sprint has quietly drifted from the plan.}

### New Source Findings (mid-sprint)
{Aggregate from Step 4.5. If zero, write "None — sprint honored the plan with no surprises."}

For each finding:
- `{source path}:{line}` — {summary}
  - Linked parked test: `{test path}` — `{test name}`
  - Recommended classification: Fix | Document | Skip (default: **Fix**)
  - Why: {one-line rationale}

### Capture as gotcha? (conditional)

{Only show this block if ANY batch returned a non-empty `Deviations from the plan` section OR a non-empty `New Source Findings` section. Omit entirely if the sprint was clean.}

Some of the deviations / findings above look like repeatable patterns worth capturing for future agents. Reply:

- **`capture {short phrase}`** — e.g. `capture sessionStorage spy quirk` — to log an entry in `.claude/skills/testing/gotchas.md`.
- **`skip`** — continue without capturing.
- You can capture multiple by chaining: `capture X; capture Y`.

When the user replies with a capture request:

1. Read `.claude/skills/testing/gotchas.md`.
2. Append a new numbered entry after the last one in the "Critical Gotchas" section. Follow the existing format: `### {N}. {Title}`, `**Problem**:`, `**Solution**:`, a code example, `**Status**: ✅ DOCUMENTED — {discovery context}`.
3. The discovery context should cite the sprint: `Discovered while executing {sprint name} (Sprint {N}) on {file path}.`
4. Confirm: `Captured gotcha #{N} in .claude/skills/testing/gotchas.md.`

If the user replies `skip` or proceeds without a capture reply, continue to Next Steps without prompting again.

### Next Steps

{Determine the review scope from the plan's **Source** field:
- If source was a folder/file path (e.g. "components/analytics") → use that as the scope
- If source was branch diff → no scope needed (branch diff is the right default)
- If source was a prior `/test-coverage` or `/test-review` → use the folder/paths from that command's scope}

{If mid-sprint findings are open — ALWAYS show this branch first:}
- Resolve the {count} new source finding{s} before moving on:
  - **Fix**: land the source change, remove the `it.todo`, convert back to a real assertion, and re-run the sprint.
  - **Document**: replace the `it.todo` with the honest-behavior assertion and a `// SOURCE DECISION: Document — {reason}` comment.
  - **Skip**: delete the parked test.
- For 1–3 findings: resolve inline now.
- For 4+ findings: consider spawning a dedicated session or subagent sweep, then return here and re-run `/test-write plan sprint {N}` (idempotent — Keep tests are unchanged).

{If more sprints remain AND no findings are open:}
- `/test-write plan sprint {N+1}` — execute the next sprint ({name})
- `/test-review {scope}` — audit quality of what was just written before proceeding
{If this was the last sprint AND no findings are open:}
- `/test-review {scope}` — audit quality of all tests written
- `/test-coverage {scope}` — verify coverage meets thresholds
- `/pre-pr` — final validation before opening a pull request
```
