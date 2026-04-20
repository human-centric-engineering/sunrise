---
allowed-tools: Bash, Glob, Grep, Read, Write, Agent
description: Review test quality with confidence-scored findings — report for the reader to judge, not a gate
---

Review existing tests for quality issues with a **confidence-scored diagnostic report**, modelled on `/codebase-review` and `/security-review`. Produces a ranked list of findings (confidence 0–100, filter ≥80) in `.reviews/tests-{slug}.md`. Lives alongside `/security-review` and `/code-review` in the PR-review flow.

**What this is:** a report for a reader (developer or PR reviewer) to judge. Findings are suggestions, not prescriptions. The report does NOT drive `/test-fix` automatically — the user reads the report and explicitly picks findings to action.

**What this is not:**

- A gate on "production ready" — confidence scoring converts variance into a sortable signal, not a binary pass/fail.
- A convergence loop — one pass, one report. No reflex re-audit after fixing.
- A remediation tool — for codebase-wide green-bar cleanup, use `/test-triage`.

**Scope bounds:** 1–20 file pairs. 21+ pairs → use `/test-triage scan <folder>` for bulk work; the 5-agent-per-pair fan-out strains at scale and per-pair confidence loses signal.

**Parallelism:** 5 specialised Sonnet agents run in parallel, each covering one quality axis across all file pairs in scope. Main (Opus) agent only aggregates and writes the report — does not read source or test files itself.

**Test type:** both unit and integration tests are supported. Type is auto-detected per file from its path (`tests/integration/**` → integration; everything else → unit). Each agent's axis prompt includes type-specific criteria; per-pair type tagging tells the agent which criteria apply to which pair.

**Accept annotations:** `// test-review:accept <issue-type> — <rationale>` in a test file drops any matching finding before it reaches the report. Agents respect these as user overrides. See "Accept annotations" below.

## Quick Start

```bash
/test-review                # Local — review branch changes, write .reviews/ report
/test-review pr             # PR — same review + post comment to current branch's PR
/test-review pr 79          # PR — target a specific PR number
/test-review lib/auth       # Local — scope to a folder
```

Most common: `/test-review pr` on a branch with an open PR. This runs eligibility checks, triviality gating, the full 5-agent review, writes the local report, and posts a comment — all in one step.

## Input

$ARGUMENTS — accepts three shapes:

- **Local mode (default)** — file paths, folder paths, or test file paths. If omitted, reviews tests for code changed on the current branch vs `origin/main`. Writes the report to `.reviews/tests-{slug}.md`.
- **PR mode (`pr` or `pr <number>`)** — auto-detect the PR for the current branch (or use the named PR number). Scopes from the PR's changed files, writes the local report AS USUAL, AND posts a comment to the PR using the official `/code-review` comment format. Silent if no findings ≥80.

## Steps

### Step 0: Detect mode and run PR eligibility (PR mode only)

If the first argument is not `pr`, skip this step entirely — local mode applies.

If the first argument IS `pr`:

1. **Resolve the PR number**:
   - `pr` alone — run `gh pr view --json number,state,isDraft,headRefName` on the current branch. If no PR exists, stop with: `No PR found for this branch. Create one with \`gh pr create\` or run \`/test-review\` without \`pr\` for a local-only review.`
   - `pr <number>` — use the explicit number. Run `gh pr view <number> --json number,state,isDraft,headRefOid,baseRefName,headRefName`.

2. **Eligibility gate** — skip (print reason and stop) if any of:
   - `state` is not `OPEN` (closed, merged → nothing to comment on).
   - `isDraft` is `true` (don't pile feedback on in-progress work).
   - The PR already has a `/test-review` comment at the latest HEAD. Detect by running `gh pr view <n> --json comments --jq '.comments[].body'` and looking for the `### Test review` header + 🤖 footer; if the most recent matching comment references the PR's current `headRefOid` (short SHA) inside its permalinks, it's already reviewed at this HEAD.

3. **Triviality check (Haiku pass)** — spawn one Haiku agent with the PR diff (limit to 200KB; if larger, summarise the file list). Prompt:

   > Given this PR diff, decide whether a test-quality review is worth running. Answer `RUN` if the PR adds or modifies production source under `lib/`, `app/`, or `components/` (including route handlers, hooks, utilities, components). Answer `SKIP` if the diff is purely: docs, config files, lockfile updates, comment-only changes, formatting/whitespace, or rename-only. Emit a single line: `RUN` or `SKIP: <one-sentence reason>`.

   If the agent returns `SKIP`, stop with: `Skipped — {reason}. No comment posted.` Do NOT proceed to the 5 Sonnet agents. (Local mode would still run if the user wants a forced review; PR mode treats triviality as a reason not to post noise.)

4. **Record PR context** for later steps:
   - `pr_number`
   - `pr_head_sha` (full SHA — for permalinks)
   - `pr_head_short` (first 7 chars — for display)
   - `pr_base_branch`
   - `pr_head_branch`
   - `repo_slug` — from `gh repo view --json nameWithOwner --jq .nameWithOwner`

   Proceed to Step 1 with PR mode active.

### Step 1: Identify test files in scope

**If arguments are test files** (paths containing `tests/` or ending `.test.ts`/`.test.tsx`):

- Review those test files directly.

**If arguments are source files or folders**:

- Map to corresponding test files using project conventions. A source file may have a unit test, an integration test, or both — include every matching test file found:
  - **Unit**: mirror under `tests/unit/`. Examples:
    - `lib/foo/bar.ts` → `tests/unit/lib/foo/bar.test.ts`
    - `app/api/v1/foo/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`
  - **Integration**: under `tests/integration/`, with the `app/` prefix stripped for route handlers. Examples:
    - `app/api/v1/foo/route.ts` → `tests/integration/api/v1/foo/route.test.ts`
    - `app/api/v1/contact/route.ts` → `tests/integration/api/v1/contact/route.test.ts`
  - For folders, find all test files (unit AND integration) corresponding to source files in the folder.

**If no arguments** (branch diff mode):

- Resolve base ref:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
  ```
- Changed files: `git diff --name-only $BASE...HEAD`
- Include test files that correspond to changed source files, plus any test files directly changed on the branch.

**If PR mode** (Step 0 set `pr_number`):

- Changed files: `gh pr diff <pr_number> --name-only` (or `git diff --name-only <base>...<head>` where base is `origin/<pr_base_branch>` and head is `origin/<pr_head_branch>`).
- Same pair resolution as branch diff mode. Ignore any explicit scope args that came after `pr` / `pr <number>` — PR mode always scopes from the PR diff.

If no test files are found, report "No test files found to review" and stop. In PR mode, also skip the comment post — silent is the right behaviour when there's nothing to say.

### Step 2: Build the file-pair list

Resolve pairs by path only — **do NOT read the files into the main context**.

- **Detect test type** from each test path: `tests/integration/**` → integration; everything else → unit.
- **Compute the source counterpart** per type:
  - **Unit** (`tests/unit/**`): strip the `tests/unit/` prefix, replace `.test.ts` → `.ts` / `.test.tsx` → `.tsx`.
  - **Integration** (`tests/integration/**`): strip the `tests/integration/` prefix; if the next segment is `api/`, prepend `app/`; replace `.test.ts` → `.ts`. Example: `tests/integration/api/v1/contact/route.test.ts` → `app/api/v1/contact/route.ts`.
- Use `Read` (not `Glob`) to verify each computed mirror path exists. Next.js dynamic-route segments (`[id]`, `[slug]`, `[...params]`) contain square brackets, which `Glob` treats as character classes — a pattern like `tests/integration/api/v1/users/[id]/route.test.ts` matches nothing even when the file exists. `Read` takes paths literally and errors cleanly on absence, which is the signal you want. If a test file exists but its source counterpart doesn't, flag it separately ("orphan test — likely rename or deletion"). Keep the orphan in the report but skip agent review.
- Emit the list: `[{ testFile, sourceFile, type: "unit" | "integration" }, ...]`.

### Step 3: Scope check

- If `pair_count == 0` and no orphans, stop with the Step 1 no-files message.
- If `pair_count > 20`, refuse:

  > Scope is {N} file pairs. `/test-review` is sized for 1–20 pairs (the 5-agent fan-out strains at scale and per-pair confidence loses signal). For bulk quality work, use:
  >
  > ```
  > /test-triage scan <folder>
  > ```
  >
  > For large branches, split the review by folder.

  Stop.

### Step 4: Load project context

- Read `CLAUDE.md` (root) and `.context/testing/patterns.md` for project testing standards.
- Read `.claude/docs/test-brittle-patterns.md` for the known anti-pattern list. The doc has two sections: `## Patterns` (general — apply to every test) and `## Integration Patterns` (#7–#13 — apply additionally to any pair tagged `type: integration`).
- Summarise as a short brief for the agents — do NOT forward full file contents; agents will read what they need themselves. If ANY pair is integration-typed, the brief MUST include the integration section headers so agents know to consult them.

### Step 5: Launch 5 parallel Sonnet review agents

Send a **single message with 5 Agent tool calls** (one per axis) using `model: "sonnet"`. Each agent receives:

- The complete list of `{testFile, sourceFile, type}` tuples — type is `unit` or `integration`.
- A brief summary of CLAUDE.md + `.context/testing/` standards.
- The known-anti-patterns list from `test-brittle-patterns.md` — both sections (`## Patterns` and `## Integration Patterns`) when any pair is integration-typed.
- Their specific review axis (below) — each includes type-specific criteria. Apply general criteria to every pair; apply integration criteria ONLY to pairs tagged `type: integration`.
- The accept-annotation grammar (so they filter annotated findings before emitting).

**Agent 1: Assertion Quality**

> Read each test file in the list. For each test file, identify assertions that would give false confidence — assertions that pass even if the code under test were deleted, or that fail to name a real contract.
>
> **General (all pairs):**
>
> - Mock-proving: assertions that only check what the mock was set up to return, with no transformation or post-condition checked.
> - Degenerate assertions: `expect(result).toBe(true)` on functions returning structured data; `.toBeDefined()` / `.toBeTruthy()` where the specific value IS the contract; `.toHaveBeenCalled()` without argument shape when args are the contract.
> - `.find(...).toBeDefined()` followed by accessing a property of the `find()` result — failure message won't name the missing element.
> - Missing assertions: tests that run code but never check the result.
> - `.not.toThrow()` on empty arrow functions — asserts nothing.
>
> **Integration-only (pairs tagged `type: integration`):**
>
> - **Status code missing** — test invokes the handler (`POST(...)`, `GET(...)`, etc.) but never asserts on `response.status`. The HTTP status IS part of the contract; body-only assertions let 200/500/etc. drift silently. See integration pattern #7 in `test-brittle-patterns.md`.
> - **Error envelope drift** — test asserts `{ error: 'string' }` or only `body.error.code` without checking `body.success === false`. Sunrise's error envelope is `{ success: false, error: { code, message, details? } }` — partial checks let shape drift ship. See integration pattern #9.
> - **Persistence asserted through the response body only** — for POST/PATCH/DELETE tests, flag when the test asserts on `body.data.X` fields that the request body trivially echoes (e.g. `expect(body.data.user.email).toBe(requestBody.email)`) and never reads the DB back. This proves the handler echoed input, not that the write landed. See integration pattern #8.
>
> For each finding, emit confidence 0–100 using the scoring guide below. Do NOT flag legitimate structural assertions (e.g. `expect(result.isPending).toBe(true)` where `isPending` is a boolean field, or `expect(body.success).toBe(true)` where `success` is the API envelope field) — score those low or don't emit.

**Agent 2: Coverage Completeness**

> Read each (test, source) pair in the list. For each pair, walk the source file and enumerate contract points; then check whether each has a corresponding test.
>
> **General (all pairs):**
>
> - `throw` statements and error-returning branches
> - `catch` blocks and error handlers
> - Validation failures (Zod parse errors, type guards failing)
> - Auth / permission checks
> - Boundary conditions (empty arrays, null, zero, max length)
> - Conditional branches with non-trivial behaviour differences
>
> **Integration-only (pairs tagged `type: integration`):**
>
> - **Auth boundary missing** — if the route uses `withAuth()`, `withAdminAuth()`, or a manual session check, the auth gate IS part of the public contract. Flag missing 401 (unauthenticated) tests and, for role-based routes, missing 403 (wrong role) tests. Public routes are exempt — note that in evidence. See integration pattern #10.
> - **Rate limiter not exercised** — if the handler calls `checkRateLimit()` or uses a limiter wrapper, flag if there's no 429 path test.
> - **DB-state unchecked** — for POST/PATCH/DELETE, flag when no test reads the DB back (via Prisma `findUnique`/`findFirst`/`findMany`) after the mutation to verify persistence, or the read-back only covers fields the request trivially dictates (no check of handler-derived fields like `id`, `createdAt`, computed defaults, normalized strings).
> - **Error response shape drift from `errorResponse()` contract** — flag tests that assert error bodies without matching the full `{ success: false, error: { code, message, details? } }` envelope.
>
> Flag any untested branches of a contract the source explicitly handles. Ignore defensive branches with no documented contract (e.g. pure paranoia `if` with no observable behaviour difference).

**Agent 3: Mock Realism**

> Read each (test, source) pair in the list. For each pair, check whether the test's mocks and helpers reflect the real boundary contracts.
>
> **General (all pairs):**
>
> - Flag helpers that re-implement source logic inline rather than importing and calling the real code (the "simulate\*" anti-pattern).
> - Flag mocks of internal implementation details rather than external boundaries (DB, API, filesystem, auth library).
> - Flag mocks that drift from the real module's API shape.
> - Flag tests that mock the code-under-test itself.
>
> **Integration-only (pairs tagged `type: integration`):**
>
> - **Real `DATABASE_URL` leak** — flag any `new PrismaClient()` instantiation in the test file that bypasses the testcontainer setup, or any test that reads `process.env.DATABASE_URL` directly. Integration tests must route through the testcontainer-aware factory so a misconfigured local run can't write to the dev DB. See integration pattern #13.
> - **Over-mocking the handler's own dependencies** — flag when an integration test mocks Prisma entirely (defeating the purpose of integration coverage) OR mocks a lib function that's core to the route's behaviour (should be exercised end-to-end). Mocking external boundaries (email sender, LLM provider, third-party HTTP) is fine; mocking internal server code is not.
> - **Session/auth mocking drift** — flag when `auth.api.getSession()` mocks return shapes that don't match the real better-auth session contract (user id, email, role fields).

**Agent 4: Brittleness & Structure**

> Read each test file in the list. Flag structural issues that make tests likely to fail spuriously or hide regressions.
>
> **General (all pairs):**
>
> - Time-dependent hardcoded values (`Date.now()`, today's date) without `vi.useFakeTimers`.
> - Shared mutable state between tests without `beforeEach` reset.
> - Execution-order coupling (tests that only pass in a specific order).
> - Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()` — masks earlier calls.
> - Dead `vi.mock(...)` blocks where no test interacts with the mock.
> - Tests that mock and then assert on the mock's setup rather than code behaviour.
>
> **Integration-only (pairs tagged `type: integration`):**
>
> - **Serial test dependency** — flag "should create X" followed by "should update X" that share state across `it()` blocks. A single failure cascades, parallelisation breaks, test names lie about what they verify. Each `it()` must arrange its own fixtures. See integration pattern #12.
> - **Module-level state not reset between tests** — flag when a test depends on clean state for rate-limiter counters, in-memory caches, singleton Prisma clients, or module-scoped counters, but only calls `vi.clearAllMocks()` in `beforeEach`. `clearAllMocks` does NOT reset module-scoped state. See integration pattern #11.
> - **Shared fixture pollution** — flag tests that seed global fixtures (users, records) in `beforeAll` but mutate them in individual tests without `beforeEach` cleanup.

**Agent 5: Test-Code Alignment**

> Read each (test, source) pair in the list. Flag mismatches between what tests claim and what they verify.
>
> **General (all pairs):**
>
> - Test title/comment describes behaviour A; assertion actually checks behaviour B.
> - Test references mocked dependencies the source no longer uses.
> - Test asserts on an older source shape (arguments, return type, error codes).
> - Test name says "should X when Y" but fixture/setup doesn't establish Y.
>
> **Integration-only (pairs tagged `type: integration`):**
>
> - **Status code mismatch with test name** — test named "should return 400 for invalid input" that never asserts `response.status === 400` (it may only check the body, letting a 500 regression pass).
> - **Error code drift** — test name references an error code (`USER_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`) that no longer matches what the source throws.

**Shared instructions for all 5 agents:**

> **Accept annotations:** before emitting any finding at line N in a test file, scan lines [N-10, N] for `// test-review:accept <issue-type> — <rationale>`. If the `<issue-type>` matches your finding's category, DROP the finding entirely — do not emit it.
>
> **Defense-in-depth check:** before emitting a finding, scan the rest of the test file for sibling tests that would catch the same regression. If 1+ siblings cover the same contract, lower your confidence by 20 points. Cite sibling line numbers in the finding.
>
> **Confidence score (0–100):**
>
> - 0–25: likely false positive or intentional pattern
> - 25–50: might be real but could be intentional or low-impact
> - 50–75: probably real but other coverage exists or impact is low
> - 75–90: very likely real — you've read the source and confirmed the gap
> - 90–100: definitely real — you can name the concrete regression that would land green
>
> **Source Findings:** if you identify an issue where the test can't meaningfully be fixed without a source change (e.g. an inline anonymous callback that can't be imported and unit-tested), emit it under a separate `SOURCE FINDINGS:` section with confidence scoring. Do NOT try to resolve these — just flag them.
>
> **Output format** — emit EXACTLY this, no preamble, no commentary:
>
> ```
> AGENT: {axis name}
>
> FINDINGS:
> - KEY: {file-stem}:{line}:{category-short}
>   FILE: {test file path}
>   LINE: {line number}
>   TYPE: {unit | integration}
>   CATEGORY: {axis}
>   CONFIDENCE: {0-100}
>   ISSUE: {one-line description}
>   EVIDENCE: {specific code reference, sibling coverage if any}
>   SUGGESTED FIX: {one-line mechanical suggestion if obvious; "needs judgement" otherwise}
> ...
>
> SOURCE FINDINGS:
> - KEY: {file-stem}:{line}:src-{category-short}
>   FILE: {source file path}
>   LINE: {line number}
>   CONFIDENCE: {0-100}
>   ISSUE: {one-line description of what makes the source untestable as-written}
>   EVIDENCE: {specific code reference}
>   SUGGESTED REFACTOR: {one-line suggestion, typically "extract as named export"}
> ...
> ```
>
> **KEY format:** `{file-stem}:{line}:{category-short}` where `file-stem` is the test filename without extension (e.g. `route.test`), `line` is the line number, and `category-short` is one of `aq` (assertion-quality), `cov` (coverage), `mr` (mock-realism), `brit` (brittleness), `align` (alignment). Example: `route.test:149:aq`. For source findings, prefix the category with `src-`: `route:210:src-cov`. The key enables mechanical de-duplication in Step 6 — when two agents emit the same key, keep the higher-confidence finding and note both axes.
>
> Keep each line under 200 chars. If you have no findings, emit `FINDINGS:` followed by nothing (empty list). Same for `SOURCE FINDINGS:`.

### Step 6: Collect, filter, and write the report

After all 5 agents return:

1. **Aggregate** findings across all agents into one list.
2. **Filter** findings with confidence < 80.
3. **De-duplicate** — group findings by `KEY`. When two or more agents emit the same key, keep the highest-confidence finding and append the other axes to its `EVIDENCE` (e.g. "also flagged by brittleness, alignment").
4. **Sort** by confidence descending, then by file path.
5. **Write** to `.reviews/tests-{slug}.md` where `{slug}` is derived from scope: folder name → that name; explicit paths → first path's folder; branch diff → `branch-{branch-name}`.

Use this format:

```markdown
# Test Quality Review — {scope}

**Reviewed:** {ISO date}
**Branch:** {branch} · **HEAD:** {head-short}
**File pairs reviewed:** {count} ({unit_count} unit · {integration_count} integration)
**Findings:** {above-threshold count} (filtered from {total count})

{One-paragraph summary: overall quality, themes that emerged, whether the test suite appears to give real confidence. If both unit and integration pairs were reviewed, note any type-specific patterns in the findings.}

## Critical Findings (90–100)

### 1. {one-line issue}

**File:** `{test path}:{line}` ({unit | integration})
**Source:** `{source path}`
**Category:** {axis}
**Confidence:** {score}

**Issue:** {description}

**Evidence:** {specific code, sibling coverage}

**Suggested fix:** {one-line or "needs judgement — {why}"}

---

## Important Findings (80–89)

(same format)

## Source Findings

{If any source findings cleared threshold — otherwise omit section. Same format; "SUGGESTED REFACTOR" replaces "SUGGESTED FIX".}

## Orphan Tests

{If any orphan test files were found in Step 2. List with "test file exists, source counterpart {path} not found — likely rename or deletion".}

## Below Threshold

{One line: "{N} findings below confidence 80 were filtered out." — do not include them.}
```

If no findings clear threshold, write:

```markdown
# Test Quality Review — {scope}

**Reviewed:** {date}
**File pairs reviewed:** {count}

No findings above confidence threshold (80). Checked for assertion quality, coverage completeness, mock realism, brittleness, and test-code alignment.

{If any source findings exist, list them here.}
```

### Step 7: Print chat summary

```
## /test-review Complete — {scope}

**Report:** `.reviews/tests-{slug}.md`
**File pairs:** {count}
**Findings ≥80:** {count} ({critical} critical, {important} important)
**Source findings:** {count}
**Orphans:** {count}

### Top findings

1. `{file}:{line}` ({score}) — {one-line issue}
2. ...
(up to 5)

### Next

This is a diagnostic report. To action findings:

- **As a reviewer** — send the report to the author, or action directly.
- **As the author** — read the report, decide which findings to fix. Then:
  - `/test-fix {slug} --findings=1,3,5` to apply specific findings (omit `--findings` for an interactive picker; `--all` to apply everything)
  - Edit tests directly for findings you want to handle manually
  - Add `// test-review:accept <type> — <rationale>` in the test file for findings you've decided are intentional (subsequent re-runs will drop them)

No reflex re-audit. Re-run `/test-review` only if the source changed after fixes, or on your next PR.
```

### Step 8: Post PR comment (PR mode only)

If Step 0 did not activate PR mode, skip this step.

**Silence condition:** if the aggregated, above-threshold finding count is 0 AND the source-findings count is 0, DO NOT post a comment. Print `PR mode: no findings ≥80 — nothing posted. Local report written for the record.` and stop.

Otherwise, build the comment body using the official `/code-review` format. GitHub permalinks use the FULL `pr_head_sha`, not a short SHA, so they survive the branch being force-pushed later.

```markdown
### Test review

{Optional one-sentence opening — the summary paragraph from the report, trimmed to ~200 chars.}

1. **{one-line issue}** ({confidence}, {category})

   https://github.com/{repo_slug}/blob/{pr_head_sha}/{file_path}#L{line-1}-L{line+1}

   {Issue paragraph from the report, 2–3 sentences max. If the report's Evidence names a concrete regression, include one sentence of that.}

   **Suggested fix:** {suggested fix line from the report}

2. ...

{If any source findings cleared threshold — one more numbered section titled "Source findings" with the same permalink + issue + suggested refactor structure.}

---

🤖 Generated with [Claude Code](https://claude.com/claude-code). Full local report: `.reviews/tests-{slug}.md` ({finding_count} findings ≥80).

React with 👍 or 👎 on this comment to help calibrate future reviews.
```

Rules for body construction:

- **Order** — Critical (90–100) first, then Important (80–89), preserving the report's ordering. Number continuously across both bands.
- **Line context** — `±1 line` around the finding's line number. If the line is 1, use `L1-L2`. If the line is the last line of the file, use `L{N-1}-L{N}`.
- **Prose** — keep each numbered item tight. No nested lists, no code blocks unless a 1–2 line snippet is load-bearing. The linked source is the context; the comment should be readable without following every link.
- **No scoring tables, no file-pair tables, no "Below Threshold" note** — those belong in the local report, not the PR comment.
- **Character budget** — aim for under 8k characters (GitHub comment practical limit is ~65k; stay well under). If the body exceeds 8k, cut the opening summary and compress each finding to 1–2 sentences.

Post with:

```bash
gh pr comment {pr_number} --body-file <path-to-temp-body-file>
```

Use a temp file (write via `Write` to `.claude/tmp/pr-comment-{pr_number}.md` then pass the path) to avoid shell-escape issues with multi-line markdown.

After posting, print:

```
Posted comment to PR #{pr_number} ({repo_slug}).
```

If `gh pr comment` fails (auth, rate-limit, network), do NOT retry silently — report the error verbatim and note that the local report is still intact at `.reviews/tests-{slug}.md`.

## Accept annotations

Findings you've decided are intentional can be silenced with an inline comment:

```ts
// test-review:accept <issue-type> — <rationale>
```

- `<issue-type>` is one of: `assertion-quality`, `coverage`, `mock-realism`, `brittleness`, `alignment`.
- Em-dash separator (`—`) required; plain `-` tolerated.
- `<rationale>` is mandatory — explain why the finding is intentional.
- Placement: within 10 lines above the flagged `it(...)` block, specific `expect(...)`, or helper.

Example:

```ts
// test-review:accept coverage — typeof window guard at user-identifier.tsx:64 unreachable in jsdom without a second test env
it.todo('should guard window access when window is undefined on authenticated-user path');
```

Agents drop annotated findings before emission. They never appear in the report.

Source-level concerns (where the test's problem is really a source problem) cannot be silenced with accept annotations — they appear under "Source Findings" regardless. Fix the source or document the constraint elsewhere.

## What this command does NOT do

- **No Block/Improve/Catalog tiers.** Confidence scoring replaces the tier model. A 95-confidence finding is "you almost certainly want to fix this"; an 82 is "worth a look". The reader decides.
- **No auto-drive into `/test-fix`.** The fix tool is explicitly user-invoked with picked findings.
- **No convergence loop.** One review, one report. If you re-run after fixes, it's a new report on new state — not an attempt to converge.
- **No gate on "production ready".** The report informs shipping decisions; it doesn't block them. `/pre-pr` may surface the report; the human judges.
- **No per-file prescriptions.** Findings are point-in-file observations. For per-test Keep/Rewrite/Add/Delete planning, use `/test-plan review` on the report (separate command — kept for multi-file coverage work).
