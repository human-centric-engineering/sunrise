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

**Accept annotations:** `// test-review:accept <issue-type> — <rationale>` in a test file drops any matching finding before it reaches the report. Agents respect these as user overrides. See "Accept annotations" below.

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

- Map to corresponding test files using project conventions:
  - `lib/foo/bar.ts` → `tests/unit/lib/foo/bar.test.ts`
  - `app/api/v1/foo/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`
  - For folders, find all test files that correspond to source files in the folder.

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

- For each test file, compute its source counterpart (mirror of `tests/unit/` into source tree; `.test.tsx` → `.tsx`).
- Use `Glob` to verify paths exist. If a test file exists but source doesn't, flag it separately ("orphan test — likely rename or deletion"). Keep the orphan in the report but skip agent review.
- Emit the list: `[{ testFile, sourceFile }, ...]`.

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
- Read `.claude/docs/test-brittle-patterns.md` for the known anti-pattern list.
- Summarise as a short brief for the agents — do NOT forward full file contents; agents will read what they need themselves.

### Step 5: Launch 5 parallel Sonnet review agents

Send a **single message with 5 Agent tool calls** (one per axis) using `model: "sonnet"`. Each agent receives:

- The complete list of `{testFile, sourceFile}` pairs.
- A brief summary of CLAUDE.md + `.context/testing/` standards.
- The known-anti-patterns list from `test-brittle-patterns.md`.
- Their specific review axis (below).
- The accept-annotation grammar (so they filter annotated findings before emitting).

**Agent 1: Assertion Quality**

> Read each test file in the list. For each test file, identify assertions that would give false confidence — assertions that pass even if the code under test were deleted, or that fail to name a real contract.
>
> Look for:
>
> - Mock-proving: assertions that only check what the mock was set up to return, with no transformation or post-condition checked.
> - Degenerate assertions: `expect(result).toBe(true)` on functions returning structured data; `.toBeDefined()` / `.toBeTruthy()` where the specific value IS the contract; `.toHaveBeenCalled()` without argument shape when args are the contract.
> - `.find(...).toBeDefined()` followed by accessing a property of the `find()` result — failure message won't name the missing element.
> - Missing assertions: tests that run code but never check the result.
> - `.not.toThrow()` on empty arrow functions — asserts nothing.
>
> For each finding, emit confidence 0–100 using the scoring guide below. Do NOT flag legitimate structural assertions (e.g. `expect(result.isPending).toBe(true)` where `isPending` is a boolean field) — score those low or don't emit.

**Agent 2: Coverage Completeness**

> Read each (test, source) pair in the list. For each pair, walk the source file and enumerate:
>
> - `throw` statements and error-returning branches
> - `catch` blocks and error handlers
> - Validation failures (Zod parse errors, type guards failing)
> - Auth / permission checks
> - Boundary conditions (empty arrays, null, zero, max length)
> - Conditional branches with non-trivial behaviour differences
>
> Then check whether each has a corresponding test. Flag any untested branches of a contract the source explicitly handles. Ignore defensive branches with no documented contract (e.g. pure paranoia `if` with no observable behaviour difference).

**Agent 3: Mock Realism**

> Read each (test, source) pair in the list. For each pair, check whether the test's mocks and helpers reflect the real boundary contracts:
>
> - Flag helpers that re-implement source logic inline rather than importing and calling the real code (the "simulate\*" anti-pattern).
> - Flag mocks of internal implementation details rather than external boundaries (DB, API, filesystem, auth library).
> - Flag mocks that drift from the real module's API shape.
> - Flag tests that mock the code-under-test itself.

**Agent 4: Brittleness & Structure**

> Read each test file in the list. Flag structural issues that make tests likely to fail spuriously or hide regressions:
>
> - Time-dependent hardcoded values (`Date.now()`, today's date) without `vi.useFakeTimers`.
> - Shared mutable state between tests without `beforeEach` reset.
> - Execution-order coupling (tests that only pass in a specific order).
> - Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()` — masks earlier calls.
> - Dead `vi.mock(...)` blocks where no test interacts with the mock.
> - Tests that mock and then assert on the mock's setup rather than code behaviour.

**Agent 5: Test-Code Alignment**

> Read each (test, source) pair in the list. Flag mismatches between what tests claim and what they verify:
>
> - Test title/comment describes behaviour A; assertion actually checks behaviour B.
> - Test references mocked dependencies the source no longer uses.
> - Test asserts on an older source shape (arguments, return type, error codes).
> - Test name says "should X when Y" but fixture/setup doesn't establish Y.

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
> - FILE: {test file path}
>   LINE: {line number}
>   CATEGORY: {axis}
>   CONFIDENCE: {0-100}
>   ISSUE: {one-line description}
>   EVIDENCE: {specific code reference, sibling coverage if any}
>   SUGGESTED FIX: {one-line mechanical suggestion if obvious; "needs judgement" otherwise}
> ...
>
> SOURCE FINDINGS:
> - FILE: {source file path}
>   LINE: {line number}
>   CONFIDENCE: {0-100}
>   ISSUE: {one-line description of what makes the source untestable as-written}
>   EVIDENCE: {specific code reference}
>   SUGGESTED REFACTOR: {one-line suggestion, typically "extract as named export"}
> ...
> ```
>
> Keep each line under 200 chars. If you have no findings, emit `FINDINGS:` followed by nothing (empty list). Same for `SOURCE FINDINGS:`.

### Step 6: Collect, filter, and write the report

After all 5 agents return:

1. **Aggregate** findings across all agents into one list.
2. **Filter** findings with confidence < 80.
3. **De-duplicate** — if two agents flagged the same file:line with similar descriptions, keep the higher-confidence one and note the second axis in `EVIDENCE`.
4. **Sort** by confidence descending, then by file path.
5. **Write** to `.reviews/tests-{slug}.md` where `{slug}` is derived from scope: folder name → that name; explicit paths → first path's folder; branch diff → `branch-{branch-name}`.

Use this format:

```markdown
# Test Quality Review — {scope}

**Reviewed:** {ISO date}
**Branch:** {branch} · **HEAD:** {head-short}
**File pairs reviewed:** {count}
**Findings:** {above-threshold count} (filtered from {total count})

{One-paragraph summary: overall quality, themes that emerged, whether the test suite appears to give real confidence.}

## Critical Findings (90–100)

### 1. {one-line issue}

**File:** `{test path}:{line}`
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

{One line: "{N} findings below confidence 80 were filtered out. Re-run with --all to see them" — but do not include them by default.}
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
- **No integration test support (v1).** `tests/integration/` has different patterns. Separate review axis later if needed.
