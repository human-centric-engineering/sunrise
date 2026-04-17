---
allowed-tools: Bash, Glob, Grep, Read, Write, Agent
description: Audit test quality — find weak assertions, happy-path-only coverage, mock-proving tests, and missing edge cases
---

Review existing tests for quality issues. Identifies tests that give false confidence — happy-path-only coverage, tests that just prove mocks work, weak assertions, and missing edge cases.

**Performance:** For 2+ file pairs, this command parallelizes audits across Sonnet subagents (one per file pair), then uses the main model for source-finding synthesis and aggregation. For a single file pair, it runs inline.

**Context discipline:** The main agent does NOT read source or test files unless source-finding synthesis specifically requires it. Subagents read their own file pair — passing file contents through the main context defeats the purpose of delegation.

## Input

$ARGUMENTS — optional file paths, folder paths, or test file paths. If omitted, defaults to reviewing tests for code changed on the current branch vs `origin/main`.

## Steps

### Step 1: Identify test files to review

**If arguments are test files** (paths containing `tests/` or ending in `.test.ts`/`.test.tsx`):

- Review those test files directly.

**If arguments are source files or folders**:

- Find the corresponding test files using project conventions:
  - `lib/foo/bar.ts` → `tests/unit/lib/foo/bar.test.ts`
  - `app/api/v1/foo/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`
  - For folders, find all test files that correspond to source files in the folder.

**If no arguments** (branch diff mode):

- Resolve base ref:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
  ```
- Get changed files: `git diff --name-only $BASE...HEAD`
- Find corresponding test files for all changed `.ts`/`.tsx` source files.
- Also include any test files that were directly changed on the branch.

If no test files are found, report "No test files found to review" and stop.

### Step 2: Build the file-pair list

**Do NOT read source or test files into the main context.** Resolve pairs by path only:

- For each test file identified in Step 1, compute its corresponding source path using project conventions (`tests/unit/...` → mirror in source tree; `.test.tsx` → `.tsx`).
- If a test file exists but its source counterpart doesn't, flag it (likely a rename/delete). Otherwise keep the pair.
- Optionally use `Glob` to verify paths exist — do not `Read` them.

Output of this step is a simple list: `[{ testFile, sourceFile }, ...]`. This drives Step 3.

### Step 3: Audit test files — parallel or inline

**Decision:** If there are **2 or more file pairs**, use parallel Sonnet subagents (Step 3a). If there is a **single file pair**, audit inline (Step 3b).

#### Step 3a: Parallel audit (2+ file pairs)

Spawn one **Sonnet** subagent per file pair using the Agent tool with `model: "sonnet"`. Send all Agent tool calls in a **single message** so they run in parallel.

The subagent reads its own file pair — do NOT inline file contents in the prompt. This keeps the main context small and the subagent's context focused.

**Subagent prompt template:**

> You are a test quality auditor. Read both files below and identify quality issues in the test file.
>
> **Source file**: `{source_path}`
> **Test file**: `{test_path}`
>
> Start by calling Read on BOTH files. Then apply the audit checklist below. Do not read other files unless they are directly imported by the test and the import is central to the finding.
>
> ## Audit checklist
>
> Classify each finding as **critical** (test gives false confidence), **warning** (test is weak but not misleading), or **info** (style improvement).
>
> {Insert the full audit criteria 3a through 3g from the "Audit criteria reference" section below}
>
> ## Output format
>
> Return findings in EXACTLY this format. Omit any section that has no entries (write nothing — not "none"). No preamble, no summary, no commentary.
>
> ```
> AUDIT: {test_path} → {source_path}
> QUALITY: Good | Acceptable | Needs Work | Poor
>
> CRITICAL:
> - [{type}] L{N}: {description} | CURRENT: {assertion} | SHOULD: {what to assert}
>
> WARNINGS:
> - [{type}] L{N}: {description}
>
> INFO:
> - [{type}] L{N}: {description}
>
> MISSING:
> - {scenario}
>
> KEEP:
> - {test name} L{N}
>
> REWRITE:
> - {test name} L{N} — {reason} | SHOULD: {what rewritten test asserts}
>
> ADD:
> - {scenario} — {why}
>
> DELETE:
> - {test name} L{N} — {reason}
> ```
>
> Keep each line under ~200 chars. Use short issue-type tags: `happy-path`, `mock-proving`, `weak-assert`, `missing-error`, `brittle`, `test-mismatch`, `untested-path`.

After all subagents return, collect their structured outputs and proceed to Step 3.5.

#### Step 3b: Inline audit (single file pair)

Read both files directly and apply the same audit criteria (3a-3g). Produce findings in the same compact format. Then proceed to Step 3.5.

---

### Audit criteria reference

These criteria are used by both Step 3a (included in subagent prompts) and Step 3b (applied inline).

#### 3a. Happy-path-only coverage (critical)

The test file only tests successful scenarios and never tests:

- Invalid inputs / validation failures
- Missing or null data
- Unauthorized access
- Database/external service errors
- Boundary values (empty arrays, max lengths, zero, negative numbers)

**What to flag**: List the specific error/edge cases the source code handles that have NO corresponding test.

#### 3b. Mock-proving tests (critical)

Tests that only verify what was set up in the mock — they'd pass even if the code under test was deleted. Signs:

- The assertion checks a value that was directly returned by `mockResolvedValue()` with no transformation
- The test mocks a function, calls the code, and only asserts the mock was called (not what the code did with the result)
- No assertions about side effects, state changes, or return value transformations

**What to flag**: The specific test case(s) and what they should assert instead.

#### 3c. Weak assertions (warning)

- `toBeDefined()` or `toBeTruthy()` when a specific value could be checked
- `toHaveBeenCalled()` without checking arguments via `toHaveBeenCalledWith()`
- `expect(result).toBe(true)` on a function that returns structured data
- Missing assertions entirely (test runs code but never checks results)
- `toMatchObject()` with a nearly empty object when specific fields should be verified

**What to flag**: The weak assertion and what it should be replaced with.

#### 3d. Missing error path tests (critical)

Read the source code and identify all error conditions:

- `throw` statements
- Error responses (4xx, 5xx status codes)
- `catch` blocks
- Validation failures
- Auth/permission checks

Then check if each error condition has a corresponding test. Flag any that don't.

#### 3e. Brittle test structure (warning)

- Tests that depend on execution order (shared mutable state between tests)
- Missing `beforeEach` cleanup / `afterEach` restore
- Hardcoded IDs, timestamps, or values that could change
- Tests that mock internal implementation details rather than the boundary

#### 3f. Test-code mismatch (critical)

- Test describes behavior that doesn't match the source code (e.g., test name says "should return 404" but asserts 400)
- Test was written against an older version of the code and no longer tests the actual behavior
- Test mocks a dependency that the source code no longer uses

#### 3g. Untested code paths (warning)

Review the source code for branches, conditions, and code paths that have no test coverage:

- `if/else` branches where only one side is tested
- `switch` cases with no tests
- Early returns that are never triggered in tests
- Optional parameters that are never tested with/without values

---

### Step 3.5: Surface source findings linked to critical test issues

This step runs in the **main agent** (not subagents) — it requires cross-file reasoning and judgment about source intent.

**Read sparingly.** Work from subagent evidence where possible (each subagent cites source line numbers and described behavior). Only `Read` a source file if you genuinely cannot classify the finding from the subagent output — e.g., the subagent flagged a "mock-proving" critical but you need to see the source line to confirm whether it's a real gap or an intentional no-op. When you do read, read only the relevant range, not the whole file.

Mock-proving tests and similar critical findings almost always sit on top of a real source gap. The test is "green" because the test was bent to fit the source, not the other way round. For every critical test finding raised in Step 3 (whether from subagents or inline), ask:

> **If this test were rewritten honestly against the source, would it pass?**

If the answer is no, the source has a gap — record it as a **Source Finding**, separate from the test rewrite.

For each source finding, pick a default classification (see `.claude/docs/test-command-file-protocol.md` for the full vocabulary):

- **Fix** (default): Source is genuinely broken. Pick this for unhandled rejections, missing validation at security boundaries, silent catch-all blocks, logic that contradicts documented intent. The fix is usually small (add `.catch()`, wrap in try/catch, add a validation check).
- **Document**: Source behavior is intentional but undocumented. Pick this when the function is meant to throw, or when the "gap" is really a deliberate no-op.
- **Skip**: The test was testing the wrong thing. Pick this when the test asserts a contract the source never claimed.

Default to **Fix** unless you have specific evidence that the behavior is intentional. Silent green-bar tests are the worse failure mode; a confident Fix default pushes the user toward honest test coverage.

Every source finding must link to the related test rewrite item(s) — they share a root cause.

Every finding is written with `Decision: {default}` and `Status: pending`. The review file is the authoritative decision-tracking record: the user resolves findings inside this conversation (inline fix, delegated subagent, or separate session — then "sync the review"), and the main agent updates the file's Status fields in-place (see Step 7). `/test-plan review` refuses to proceed until every finding is `resolved` or `accepted`.

### Step 4: Write full findings to file

Write the complete review to `.claude/tmp/test-review.md`, overwriting any prior run. This file is the authoritative record — `/test-plan review` reads from it. Follow the shared protocol in `.claude/docs/test-command-file-protocol.md` — every file must start with the metadata frontmatter block.

Before writing, capture git state with Bash:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

The file format:

```markdown
---
command: test-review
scope: {scope string — e.g., "components/analytics" or "branch diff vs origin/main"}
mode: targeted | branch-diff
branch: {current branch}
head: {current HEAD SHA}
generated: {ISO 8601 UTC timestamp}
---

# Test Quality Review

**Files reviewed**: {count} test files for {count} source files

## Summary

- **Critical**: {count} — tests give false confidence, fix before merging
- **Warnings**: {count} — tests are weak, improve when possible
- **Info**: {count} — style improvements, low priority
- **Source findings**: {count} — suspected source gaps linked to critical test issues ({fix count} Fix, {doc count} Document, {skip count} Skip)

**Ready for merge**: Yes / No (fix critical issues AND resolve source findings first)

---

## File: `{test file path}` → `{source file path}`

**Overall quality**: Good / Acceptable / Needs Work / Poor

### Critical Issues

1. **{Issue type}** (line {N}): {description}
   - **Current**: `{the weak/wrong assertion or missing test}`
   - **Should be**: `{what should be tested instead}`

### Warnings

{numbered list}

### Info

{numbered list}

### Missing Test Cases

- [ ] {description}

---

{repeat for each file}

## Source Findings

Suspected source gaps linked to critical test issues. This section is the authoritative decision-tracking record — each finding carries a `Decision` (default: Fix) and `Status` (starts: pending). `/test-plan review` refuses to run until every finding is `resolved` or `accepted`.

### `{source file path}:{line}` — {one-line summary}

**Linked test item(s)**: `{test file path}:{line}` — `{test name}` (+ any siblings in the same Rewrite cluster)
**Decision**: Fix (default) | Document | Skip
**Status**: pending
**Reasoning**: {one short paragraph — what the source actually does today, what the contract should be, why this classification}
**If Fix**: {concrete source change — e.g. "add `.catch(logger.error)` on line 81", "wrap `sessionStorage.getItem` in try/catch returning null"}
**If Document**: {what the test should assert instead — the honest current behavior}
**If Skip**: {which test(s) to delete and why no replacement is needed}

---

{repeat for each source finding}

## Structured Findings

Consumed by `/test-plan review`.

### `{source file path}` → `{test file path}`

**Keep**:

- `{test name}` (line {N})

**Rewrite**:

- `{test name}` (line {N}) — {reason}. Should: {what the rewritten test should assert}. {If linked to a source finding: `Linked source finding: {source path}:{line}`}

**Add**:

- {scenario description} — {why}

**Delete** (optional — only if truly redundant):

- `{test name}` (line {N}) — {reason}

---
```

### Step 5: Print terse summary to chat

Do NOT print the full review in chat. Print a short, scannable summary only — the user can open the file if they need details.

Format:

```
## Test Quality Review — {scope}

{N} files reviewed · **{C} critical · {W} warnings · {I} info** · **{S} source findings ({Fix}/{Doc}/{Skip})**
{If parallel mode: "Audited via {N} parallel Sonnet agents + Opus source analysis"}
Full findings: `.claude/tmp/test-review.md`

| File | Quality | C | W | I |
|------|---------|---|---|---|
| {filename} | {Good/Acceptable/Needs Work/Poor} | {count} | {count} | {count} |
{...one row per file}

### Top critical issues
{Up to 5 one-liners, highest-impact first. Format: `file.test.tsx:NN — {issue type}: {one-sentence why}`}
{If 0 critical issues: omit this section and write "No critical issues."}

### Source findings ({S})
{Up to 3 highest-impact, one per line: `- source/path.ts:NN — {default classification}: {one-sentence why}`}
{If 0: omit section entirely}
{If >3: "(+{N} more in file)"}

**Ready for merge**: {Yes / No — fix {C} critical issues AND resolve {S} source findings first}

{If 0 source findings:}
Next: `/test-plan review {scope}` → `/test-write plan`

{If 1+ source findings:}
Next: resolve the {S} source finding{s} first — see options below. Once every finding is `resolved` or `accepted`, run `/test-plan review {scope}`.
```

Keep it under ~22 lines of chat output regardless of how many files were reviewed. If there are more than 5 critical issues across all files, show the top 5 and note "(+{N} more in file)".

### Step 6: Offer next action

After the summary, branch on the number of source findings. The goal is to keep decision-making **here in this conversation** — do not punt to `/test-plan review` while findings are still pending.

#### If 0 source findings

> Want me to fix the critical test issues? Next step: `/test-plan review {scope}` turns the findings into an execution plan, then `/test-write plan` runs it.
>
> _(Replace `{scope}` with the folder or file paths this review targeted. Omit if this was a branch diff review.)_

#### If 1–3 source findings

The right move is usually a small inline fix. List the findings with the `If Fix` recommendation and offer to apply them:

> {S} source finding{s} need a decision before the plan step. Defaults are **Fix** — small changes I can apply inline right now:
>
> - `{source path}:{line}` — {one-line summary of the If Fix change}
> - ...
>
> Options:
>
> - Say **"fix them"** (or name specific ones) to apply the default Fix now.
> - Say **"document {finding}"** or **"skip {finding}"** to override the default and accept as-is.
> - Say **"I'll handle these separately"** if you want to fix them externally (another session, your editor, a subagent sweep), then come back and say **"findings are fixed"** or **"sync the review"** to have me verify and update the review.
>
> Once every finding is `resolved` or `accepted`, run `/test-plan review {scope}`.

#### If 4+ source findings OR any individually complex fix

Inline resolution stops scaling. Recommend external handling with a sync-back:

> {S} source findings need a decision — too many to resolve cleanly inline. Recommended flow:
>
> 1. Handle the fixes externally — a dedicated session, a subagent sweep, or your editor. The review file at `.claude/tmp/test-review.md` has the full `If Fix` recommendation for each finding, so whoever does the work has everything they need.
> 2. Optionally override defaults first — say **"document {finding}"** or **"skip {finding}"** for any you want to accept as-is (I'll flip those to `accepted` immediately).
> 3. When the fixes land, come back to this conversation and say **"findings are fixed"** or name which ones are done. I'll re-read the affected source ranges, verify each fix matches the `If Fix` recommendation, and update the review's Status fields.
>
> Once every finding is `resolved` or `accepted`, run `/test-plan review {scope}`.

### Step 7: Resolve findings (respond to inline fix / sync requests)

This step runs when the user asks you to apply, accept, or verify source findings after the review has been written. The trigger phrases cluster around:

- **Apply defaults**: "fix them", "fix {finding name}", "apply the fix", "do the inline fixes"
- **Override defaults**: "document {finding}", "skip {finding}", "accept {finding} as document/skip"
- **Sync after external work**: "findings are fixed", "sync the review", "check the fixes", "I've fixed {finding}"

Always work from `.claude/tmp/test-review.md` — re-read it to get the current state of every finding's `Decision` and `Status` before acting.

#### 7a. Apply inline fixes (Decision = Fix, user says "fix them")

For each finding the user asked to fix:

1. Read the source range referenced in the finding's `If Fix` line (narrow range — just enough to make the change). This is the Step 3.5 carve-out; reading the whole file is unnecessary.
2. Apply the change using `Edit`. If the fix requires a new import (e.g. `logger`), add it too.
3. Run `npm run type-check` and `npm run lint` scoped to the changed file. If either fails, report and stop — do not flip status until the fix is clean.
4. Update `.claude/tmp/test-review.md`: flip that finding's `Status: pending` to `Status: resolved`. Leave `Decision: Fix` as-is.
5. Move to the next finding. After all requested fixes are applied, print a short summary.

#### 7b. Accept overrides (Decision = Document or Skip)

The user has chosen to not change the source. For each finding being overridden:

1. No source read or change needed — this is a classification flip.
2. Update `.claude/tmp/test-review.md`: change that finding's `Decision` from `Fix` to `Document` (or `Skip`) and flip `Status: pending` to `Status: accepted`.
3. The review's `Structured Findings` block still references the finding's test items — those will be handled by the plan/write steps according to the new Decision (Document → assert honest current behavior; Skip → delete test).

#### 7c. Sync after external fixes (user says "findings are fixed")

For each `pending` finding with `Decision: Fix`:

1. Read the source range referenced in the `If Fix` line.
2. Verify the fix matches the recommendation — concretely:
   - "Add `.catch(logger.error)` on line 81" → confirm a `.catch(...)` handler is now present at/near that line and `logger` is imported.
   - "Wrap X in try/catch returning null" → confirm a `try`/`catch` block is present around the call.
   - Match is semantic, not syntactic — if the fix uses a different logger method or a different variable name but achieves the same contract, accept it.
3. If verified: flip `Status: pending` to `Status: resolved`.
4. If NOT verified: leave `Status: pending` and record a short note in your summary — e.g., "line 81 still has `void initialize()` with no catch handler; fix not detected". The user can either land the fix or explicitly accept a Document/Skip override.
5. If the user also overrode some findings (Document/Skip), apply those per 7b at the same time.

#### 7d. Report after any Step 7 action

Print a compact summary:

```
Review sync — `.claude/tmp/test-review.md` updated:
- resolved: {N} ({list})
- accepted: {N} ({list})
- still pending: {N} ({list with reason})

{If 0 pending:}
All source findings resolved. Next: `/test-plan review {scope}` → `/test-write plan`.

{If >0 pending:}
Remaining findings need attention before the plan step. See options from Step 6.
```

Keep it under 10 lines. The review file itself has the full detail.
