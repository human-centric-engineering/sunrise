---
allowed-tools: Bash, Glob, Grep, Read, Write, Agent
description: Analyze code and produce a phased, prioritized test plan with agent batching strategy
---

Analyze code and produce a detailed, phased test plan. This is the planning step — run this before `/test-write`. The plan defines what tests are needed, how to batch agent work, and in what order (sprints/phases).

**Context discipline:** When consuming a prior `/test-review` or `/test-coverage` file, **trust its findings** — do not re-read source files to "verify" them; the reviewer already did that work. Only read source files in fresh-analysis mode (branch-diff or direct folder/file arg), and for 4+ files delegate the per-file analysis to parallel Sonnet subagents.

## Input

$ARGUMENTS — determines scope and may incorporate prior command findings:

- **No arguments** → branch diff mode: analyze all changes on current branch vs `origin/main`
- **File/folder paths** → analyze those specific paths
- **`review`** → incorporate findings from a prior `/test-review` in the conversation
- **`coverage`** → incorporate findings from a prior `/test-coverage` in the conversation
- **Combinations** → e.g., `review lib/auth` (incorporate review findings, scoped to a folder)

When `review` or `coverage` is specified, use the **most recent** matching command output in the conversation. If multiple exist, ignore older ones.

## Steps

### Step 1: Identify target files

**If `coverage` keyword is present:**

- Read `.claude/tmp/test-coverage.md` and follow the reader protocol in `.claude/docs/test-command-file-protocol.md`:
  1. Parse the frontmatter metadata.
  2. Hard-stop if the invocation scope disagrees with the file's scope.
  3. Soft-warn on age >1h, branch change, or HEAD change.
  4. Print the provenance line before proceeding.
- If the file does not exist, tell the user to run `/test-coverage` first and stop.
- Use the `## Structured Findings` section: file list, actions (CREATE/ADD), sprint assignments, gap descriptions.

**If `review` keyword is present:**

- Resolve the review file under `.reviews/`:
  - `review` with an optional scope arg (e.g. `review lib/auth`) — compute slug (`lib/auth` → `lib-auth`); look for `.reviews/tests-{slug}.md`.
  - `review` alone — pick the most recently modified `.reviews/tests-*.md` by mtime.
  - If no matching report exists, tell the user to run `/test-review [scope]` first and stop.
- Print a provenance line (`Review: .reviews/tests-{slug}.md — {age} old · branch {branch} · HEAD {head-short}`).
- Soft-warn on age >1h; hard-pause on age >24h OR branch/HEAD drift against the review's metadata — the user must explicitly continue.
- Parse the report:
  - `## Critical Findings (90–100)` and `## Important Findings (80–89)` — assign continuous 1-based indices.
  - `## Source Findings` — assign `S1, S2, …`.
  - Dependency map: any finding whose `Suggested fix` mentions "Source Finding N" / "Depends on Source Finding N" depends on the matching `S{N}`.

**Source finding gate (review mode only, runs inline during Step 1):**

New reviews are confidence-scored reports, not state machines — there is no `Status: pending/resolved/accepted`. Instead, the planner surfaces each referenced source finding to the user once, captures the decision, and carries it into the plan.

For each source finding referenced by one or more selected test findings, ask:

```
### Source Finding S{N} — `{file}:{line}` (confidence {conf})

**Issue:** {issue paragraph}
**Evidence:** {evidence}
**Suggested refactor:** {refactor snippet or description}
**Blast radius:** {blast line}
**Depended on by:** findings {list of indices}

Action for this source finding? (fix / document / skip)
- `fix` — include the refactor in the plan's Source Decisions block; dependent test findings assume the refactor has landed when /test-write executes.
- `document` — leave the source as-is; dependent tests assert the CURRENT behaviour and get a `// SOURCE DECISION: Document` annotation.
- `skip` — drop the dependent test findings from the plan entirely.
```

Record the user's decision (`fix` / `document` / `skip`) against each source finding. If the user picks `skip`, drop every dependent finding from the plan's work list before continuing to Step 2.

If every selected test finding got dropped via `skip`, stop with: `Every selected finding depends on a source finding you skipped. Nothing to plan.`

**If file/folder paths provided (without `review`/`coverage`):**

- Resolve the provided paths
- For folders, find all `.ts` and `.tsx` files within them (excluding test files)

**If no arguments** (branch diff mode):

- Resolve the correct base ref:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
  ```
- Get changed files: `git diff --name-only $BASE...HEAD`
- Filter to `.ts` and `.tsx` files, excluding:
  - Test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`)
  - Type declaration files (`*.d.ts`)
  - Configuration files (`vitest.config.ts`, `eslint.config.*`, `next.config.*`, `tailwind.config.*`)
  - Layout/loading/error boundary files (`layout.tsx`, `loading.tsx`, `error.tsx`)
  - Barrel files that only re-export

**Merging findings:** If both `review` and `coverage` findings exist for the same file, combine them:

- Coverage CREATE → include all behaviors from coverage.
- Coverage ADD gaps → merge with review findings classified as `Add` (deduplicate by scenario).
- Review findings → classify by category (see Step 2a for the rules), then include verbatim.
- Review **Source Findings** with a `fix` decision → lift into a Source Decisions block (see Step 5.5). `document` / `skip` decisions flow into per-test rewrite strategy and don't appear in the audit block.

Report the list of target files to the user.

If there are no target files, report "No files to plan tests for" and stop.

### Step 2: Analyze each file

The analysis strategy depends on where the file list came from:

#### Step 2a: From a prior review/coverage file (`review` / `coverage` modes)

**Do NOT re-read source files** to "verify" the prior command's findings. The reviewer / coverage analyzer already read them. Use those findings directly:

- **Review findings** — each confidence-scored finding at `{testFile}:{line}` maps to one plan item. Classify by the finding's `Category`:
  - `Coverage Completeness` → **Add** (a missing test case).
  - `Assertion Quality` / `Mock Realism` / `Test-Code Alignment` / `Brittleness & Structure` → **Rewrite** (fix an existing test at the named line).
  - If two findings target the same test at the same line, merge into one Rewrite item (record both concerns in the "why" field).
- **Source Findings** — decision captured in Step 1's gate: `fix` → Source Decisions (Step 5.5); `document` → per-test Rewrite with a documenting comment; `skip` → test finding already dropped upstream.
- **Coverage gaps** → Add items with the gap description as the "why".
- **File type, complexity, dependencies**: infer from the file path and the prior command's observations. If the review/coverage file didn't capture a piece of metadata you need for batching (rare), spot-`Read` only that file — not the entire target list.

This path should produce a plan with zero source-file Reads in the main context.

#### Step 2b: Fresh analysis (branch-diff, folder, or file args)

Work through each target file and extract:

1. **File type** — classify from the path and, if needed, a brief Read:
   - `validation` — Zod schemas, validation functions
   - `utility` — Pure functions, helpers, formatters
   - `api-route` — Route handlers in `app/api/`
   - `server-action` — Server actions (`'use server'`)
   - `component` — React components (`.tsx` outside `app/api/`)
   - `page` — Page components (`page.tsx`)
   - `middleware` — Auth guards, rate limiters, middleware
   - `database` — Prisma operations, database utilities
   - `hook` — React hooks (`use*.ts`)
   - `config` — Configuration, constants
   - `other` — Anything else
2. **Complexity** — score using function count (×2), Prisma/db (+10), better-auth (+8), external APIs (+8), file system (+5), side effects (×3), branching (×2). <10 simple, 10–24 medium, 25+ complex.
3. **Dependencies to mock** — Prisma, auth, logger, Next.js headers/cookies, fetch, etc.
4. **Key behaviors** — happy path, validation/error cases, edge cases, security paths.
5. **Existing test state** — check for the corresponding test file (`tests/unit/...`, `tests/integration/...`). If present, classify existing tests as keep/rewrite and note what's missing.

**Parallelization for fresh analysis:**

- **1–3 target files** — analyze inline in the main agent (subagent overhead exceeds savings).
- **4+ target files** — spawn one **Sonnet** subagent per file using `Agent` with `model: "sonnet"`. Send all calls in a single message to run them in parallel. Each subagent reads its own source + existing test file (do NOT inline contents in the prompt).

**Subagent prompt template (fresh analysis, 4+ files only):**

> You are a test planner. Analyze one source file and, if present, its existing test file, and produce structured planning metadata.
>
> **Source file**: `{source_path}`
> **Existing test file** (if it exists): `{test_path}` — check with Read; skip gracefully if not found.
>
> Read both files (or just the source if no test exists). Extract the fields below and return them in the exact format specified. No preamble, no summary.
>
> Fields to extract: file type, complexity (simple/medium/complex), dependencies to mock, key behaviors (happy path + error/edge cases), existing-test classifications (keep/rewrite/missing).
>
> ```
> PLAN: {source_path}
> TYPE: {file type}
> COMPLEXITY: simple | medium | complex
> MOCKS: {comma-separated dependencies}
> TEST_FILE: {test path or "none"}
>
> BEHAVIORS:
> - {behavior — happy path, edge, error}
>
> KEEP:
> - {test name} L{N}
>
> REWRITE:
> - {test name} L{N} — {reason} | SHOULD: {what to assert}
>
> MISSING:
> - {scenario} — {why}
> ```
>
> Omit any section with no entries. Keep lines under ~200 chars.

After subagents return, aggregate their outputs — do not re-read the files.

### Step 3: Prioritize

Sort the files into a prioritized implementation order:

**Priority 1 — Security-critical** (must be 90%+ coverage):

- Auth utilities, guards, session management
- Input validation schemas
- Rate limiting, sanitization
- PII/data scrubbing

**Priority 2 — Core infrastructure** (must be 85%+ coverage):

- API response utilities
- Error handlers
- Database utilities
- Shared middleware

**Priority 3 — API endpoints** (must be 80%+ coverage):

- Route handlers (POST/PATCH/PUT/DELETE first, then GET)
- Server actions

**Priority 4 — Components and pages** (must be 70%+ coverage):

- Forms with validation
- Interactive components
- Pages with data fetching

**Priority 5 — Low-risk utilities** (must be 70%+ coverage):

- Pure formatting functions
- Constants/config
- Simple hooks

Within each priority level, order by:

1. Files with NO existing tests first
2. Files with partial coverage second
3. Files with outdated tests (testing old behavior) third

### Step 4: Build per-file work instructions

For each file, produce structured instructions that `/test-write` will pass to test-engineer agents:

```
### {source file path}
**Test file**: {path} (CREATE / UPDATE)
**Type**: {file type}
**Complexity**: simple / medium / complex
**Coverage target**: {percentage based on module type}

**Keep** (do not modify):
- `{test name}` (line {N})

**Rewrite** (fix these existing tests):
- `{test name}` (line {N}) — {reason}. Should: {what the rewritten test should assert}

**Add** (new test cases needed):
- {scenario description} — {why: error path / edge case / uncovered branch at source line N}

**Mocking requirements**:
- {dependency}: {mock strategy}
```

**Self-check before writing each file's instructions:**

- **Add/Rewrite overlap** — for every Add item, check whether an adjacent Rewrite already implies it. Example: if a Rewrite now asserts `toHaveBeenCalledWith({...})`, it already proves single-fire, so a separate "called exactly once" Add is redundant. Drop the Add, or merge its intent into the Rewrite's assertion.
- **Rewrite recommendation shape** — if your "Should" line prescribes `toHaveBeenNthCalledWith` across multiple renders, split the rewrite into separate `it` blocks (one render each) before forwarding. See `.claude/docs/test-brittle-patterns.md` for the full anti-pattern list the plan and agent should steer clear of.

### Step 4.5: Source sanity check on Rewrite prescriptions (from-review mode only)

Runs only in `from-review` mode — the review's `Should:` lines are concrete assertion prescriptions that can be validated against current source. Coverage and branch-diff modes don't produce prescriptions to check.

The goal is to catch plan-level errors before the agent hits them mid-execution. A prescribed `toHaveBeenCalledTimes(2)` that's impossible given a source-level guard, or a prescribed signature that doesn't match the real call site, costs ~50k agent tokens to discover during `/test-write`. Spotting it here costs ~5k planner tokens.

For each **Rewrite** item across all files whose `Should:` line prescribes a specific call count (`toHaveBeenCalledTimes(N)`, `.not.toHaveBeenCalled()`) or a specific call signature (`toHaveBeenCalledWith({...})`):

1. Identify the source function, hook, or effect that the linked test exercises. Use the review's line references plus the test's existing assertions as context.
2. Read the narrow source range around that function/effect — just the relevant closure, not the whole file.
3. Check for structural elements that could invalidate the prescribed assertion:
   - **One-shot `useRef` guards** (e.g. `if (someRef.current) return`) that block re-runs on the same component instance. A count=2 prescription against a guarded-once effect will never pass without a fresh mount.
   - **Early returns** that skip the call path being asserted under realistic test conditions.
   - **Conditional effects / dependencies** — `useEffect(() => {...}, [dep])` where the prescribed call only fires under specific `dep` values.
   - **Async ordering** — prescribed counts that assume a synchronous path that's actually gated on a promise chain.
   - **Signature drift** — the prescribed `toHaveBeenCalledWith({...})` object shape doesn't match what the source actually passes to the mocked function.
4. If anything looks suspicious, record it in a `Sanity-check flags` list. If the prescription checks out, silently pass.

**Rules:**

- Read only the source ranges you need. One targeted `Read` per suspicious Rewrite — not a whole-file read per file.
- Each flag is a soft signal, not a block. Include it in the plan file and the terse summary so the user sees it during the usual confirmation flow.
- False positives are acceptable (user reads the note and waves it through). False negatives — missed catches — are the cost this step exists to avoid.
- Do NOT modify the `Should:` line automatically. The plan records the review's prescription plus the flag; the user chooses whether to adjust before running `/test-write`.

The flags are rendered into the plan file as a `## Sanity-Check Flags` section (see Step 6 format). `/test-write` reads them and passes them through to the test-engineer agent as "if you hit this, it's a plan error — follow the gotchas doc and revise the assertion, don't park as a source finding."

### Step 5: Design the execution phases

Group the work into **sprints** (phases) that can be executed independently. Each sprint should be a coherent chunk of work that a user can approve, execute, and verify before moving to the next.

**Sprint design principles:**

- Each sprint should be completable in a single `/test-write` run
- Earlier sprints should not depend on later sprints
- Group files by shared mocking setup within sprints for efficient agent batching
- Keep sprints to a manageable size (roughly 5-10 files max per sprint)
- For branch-diff mode with few files, a single sprint is fine

**Within each sprint, define agent batches:**

- **Simple batch** (validation, pure utilities): Up to 3-4 files per agent
- **Medium batch** (API utils, middleware): 1-2 files per agent
- **Complex batch** (API routes, database, auth): 1 file per agent

Files in the same batch should share similar mocking requirements.

### Step 5.5: Build the Source Decisions audit block

Consume the decisions captured during Step 1's source-finding gate. The block exists for traceability: anyone reading the plan can see which source gaps were accepted as refactors versus documented or skipped.

For each source finding with decision `fix` or `document`, record:

```markdown
### `{source path}:{line}` — {summary}

**Linked test items**: {list of finding indices, e.g. "1, 3, 4"} — `{test file}:{line}` — `{issue}`
**Decision**: Fix | Document
**Reasoning**: {short line — "refactor pre-approved for clean hook extraction" / "behaviour intentional; assert as-is"}
**If Fix**: {refactor description from the review, including any code snippet and blast radius}
**If Document**: {what the test should assert about the current behaviour + SOURCE DECISION comment text}
```

`skip` decisions don't appear here — the dependent test findings were already dropped from the work list in Step 1.

**Per-test rewrite instructions inherit the decision:**

- `Fix` → test-engineer applies the source refactor first, then rewrites the test against the fixed contract.
- `Document` → test asserts the CURRENT behaviour and includes a `// SOURCE DECISION: Document — {reason}` comment so the next reviewer sees why the apparent smell is intentional.

If no source findings were referenced, or every decision was `skip`, omit the Source Decisions block from the plan entirely.

### Step 6: Write the full plan to file

Write the complete plan to `.claude/tmp/test-plan.md`, overwriting any prior plan. This file is the authoritative record — `/test-write plan` reads from it. Follow the shared protocol in `.claude/docs/test-command-file-protocol.md` — every file must start with the metadata frontmatter block.

Before writing, capture git state with Bash:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

The file format:

```markdown
---
command: test-plan
scope:
  {
    scope string — inherit from the prior review/coverage file if consuming one,
    else the path args,
    else "branch diff vs origin/main",
  }
mode: targeted | branch-diff | from-review | from-coverage
branch: { current branch }
head: { current HEAD SHA }
generated: { ISO 8601 UTC timestamp }
---

# Test Plan

**Source**: {what drove this plan — branch name, folder paths, or prior command + its file}
**Target files**: {count}
**Estimated complexity**: {simple} simple, {medium} medium, {complex} complex
**Sprints**: {count}
**Source decisions**: {count} — {fix_count} Fix, {document_count} Document, skipped dependents dropped during planning
**Sanity-check flags**: {count} — Rewrite prescriptions flagged against current source (from-review mode only; 0 in other modes)

---

## Sanity-Check Flags

{Only included if Step 4.5 flagged anything — from-review mode only. Omit section entirely if 0.}

Rewrite prescriptions whose `Should:` assertion looks suspicious given the current source. Each flag is a soft signal, not a block. Review each before running `/test-write`; if the concern is real, adjust the `Should:` line in the per-file Rewrite section below. `/test-write` will pass each flag through to the test-engineer agent as "if you hit this mid-execution, it's a plan error — revise the assertion, do not park as a source finding."

### `{source path}:{line}` — `{test name}`

**Prescribed**: `{Should: line from the review / per-file Rewrite section}`
**Concern**: {one-line note — which guard / early return / conditional / signature mismatch was spotted}
**Suggested revision**: {optional — if there's an obvious fix, suggest it; otherwise say "adjust during review"}

---

{repeat per flag}

## Source Decisions (audit)

{Only included if source findings with decision `fix` or `document` were captured during Step 1. Omit entirely otherwise.}

Captured during Step 1's source-finding gate. `/test-write` reads these to pick the right rewrite strategy per linked test: Fix → apply refactor first then test against fixed contract; Document → assert current behaviour with SOURCE DECISION comment.

### `{source path}:{line}` — {summary}

**Linked test items**: {finding indices} — `{test file}:{line}` — `{issue}`
**Decision**: Fix | Document
**Reasoning**: {short rationale}
**If Fix**: {refactor description including any code snippet and blast radius from the review}
**If Document**: {what the test should assert + SOURCE DECISION comment text}

---

{repeat per source decision}

## Brittle Patterns to Avoid

Test-engineer agents must check this list before writing or rewriting any test in this plan. Authoritative source (and extensions): `.claude/docs/test-brittle-patterns.md`.

- **Multi-render `toHaveBeenNthCalledWith` in one `it` block** — index-dependent assertions shift on earlier failures. Split into separate `it` blocks.
- **`.not.toThrow()` on empty arrow functions** — `expect(() => {}).not.toThrow()` is tautological. Assert an observable post-error state instead.
- **Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()`** — wipes history; the negative assertion becomes trivially true. Use explicit counts (`toHaveBeenCalledTimes(N)`) before and after the action.
- **Dead `vi.mock(...)` blocks** — if the source no longer imports the module, delete the mock rather than annotate it. Dead mocks mislead future readers.
- **`.toBeDefined()` after `.find()`** — produces unhelpful failure messages. Assert the specific element/property, or query with a selector that throws descriptively when missing.
- **Add/Rewrite overlap in your assignment** — if an Add duplicates what a Rewrite already asserts, flag it in your final output and merge rather than writing both tests.

---

## Sprint 1: {name}

**Files**: {count} · **Estimated agents**: {count} · **Priority**: {level}

### Batch 1.1: {description}

| #   | File   | Action        | Complexity            | Keep    | Rewrite | Add     | Delete  |
| --- | ------ | ------------- | --------------------- | ------- | ------- | ------- | ------- |
| 1   | `path` | CREATE/UPDATE | simple/medium/complex | {count} | {count} | {count} | {count} |

{Per-file work instructions from Step 4 for each file in this batch}

### Batch 1.2: {description}

...

---

## Sprint 2: {name}

...

---

## Mocking Requirements

{Unique dependencies across sprints with mock strategy — reference `.context/testing/mocking.md`}

## Summary

| Sprint | Files   | Agents  | Priority   | Scope   |
| ------ | ------- | ------- | ---------- | ------- |
| 1      | {count} | {count} | {priority} | {brief} |

## Notes

{Observations affecting testing strategy — tight coupling, missing source-level validation, source changes recommended before testing, etc.}
```

### Step 7: Print terse summary to chat

Do NOT print the full plan in chat. Print a short, scannable summary only — the user can open the file for per-file detail.

Format:

```
## Test Plan — {scope}

{N} files · {simple}/{medium}/{complex} simple/medium/complex · {S} sprint{s}{If source decisions: · **{D} source decision{s} carried forward ({R} resolved, {A} accepted)**}{If sanity-check flags: · **{F} sanity flag{s} — review before /test-write**}
Full plan: `.claude/tmp/test-plan.md`

{If sanity-check flags present, show BEFORE source decisions and sprint table — this is the signal the user most needs to act on:}
### Sanity-Check Flags ({F})
{Up to 3 highest-concern, one per line: `- source/path.ts:NN — {test name}: {concern summary}`}
{If >3: "(+{N} more in file — open `.claude/tmp/test-plan.md` to review)"}

{If source decisions present, show a compact audit line BEFORE the sprint table:}
### Source Decisions (audit — captured during planning)
{Up to 3 highest-impact, one per line: `- source/path.ts:NN — Fix: {refactor summary}` or `- source/path.ts:NN — Document: {reason}`}
{If >3: "(+{N} more in file)"}

| Sprint | Batch | Files | Priority | Focus |
|--------|-------|-------|----------|-------|
| 1 | 1.1 | {count} | {priority} | {brief — e.g., "Validation schemas"} |
| 1 | 1.2 | {count} | {priority} | {brief} |
| 2 | 2.1 | {count} | {priority} | {brief} |

### Notes
{Up to 3 bullets covering test-strategy notes — tight coupling, shared mock setup, ordering dependencies. If none, write "None — plan is self-contained."}

Next: `/test-write plan` (Sprint 1) · `/test-write plan sprint N` · `/test-write plan all`
```

Keep chat output under ~28 lines regardless of plan size. If there are >6 batches, show the first 6 and note "(+{N} more in file)".

### Step 8: Offer to execute

After the summary, ask:

> Plan ready. Which sprint would you like to execute?
>
> - `/test-write plan` — execute Sprint 1 (recommended)
> - `/test-write plan sprint 2` — execute a specific sprint
> - `/test-write plan all` — execute all sprints sequentially
>
> Or raise any of the Notes items first if a test-strategy concern needs discussion.

Do NOT write any test files — this command only produces the plan. Use `/test-write` to execute it.
