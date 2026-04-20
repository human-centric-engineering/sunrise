# Test Command File Protocol

The `/test-*` commands use files in `.claude/tmp/` (gitignored) to pass structured findings between steps. This keeps chat terse and makes each step's output inspectable by the user. This document defines the file format, metadata contract, and sanity-check rules every test command must follow.

## Files

| Command          | Writes to                      | Reads from (when consuming prior output) |
| ---------------- | ------------------------------ | ---------------------------------------- |
| `/test-review`   | `.claude/tmp/test-review.md`   | —                                        |
| `/test-coverage` | `.claude/tmp/test-coverage.md` | —                                        |
| `/test-plan`     | `.claude/tmp/test-plan.md`     | `test-review.md` / `test-coverage.md`    |
| `/test-write`    | —                              | `test-plan.md`                           |
| `/test-fix`      | —                              | `test-review.md`                         |

Each write overwrites the prior file — there is no history. `.claude/tmp/` is in `.gitignore`.

## File format

Every file starts with a YAML frontmatter block, followed by the command's human-readable content.

```markdown
---
command: test-review | test-coverage | test-plan
scope: <scope string — see below>
mode: targeted | branch-diff | from-review | from-coverage
branch: <output of `git rev-parse --abbrev-ref HEAD`>
head: <output of `git rev-parse HEAD`>
generated: <ISO 8601 UTC timestamp, e.g. 2026-04-17T10:23:00Z>
---

# {Human-readable title}

...command-specific content...
```

### Scope string conventions

The `scope` field is what the reader sanity-checks against. Use these exact forms:

- Folder or file arg passed by the user → use it verbatim: `components/analytics`, `lib/auth/guards.ts`
- No args, branch diff mode → `branch diff vs origin/main`
- No args, whole project (coverage only) → `whole project`
- Prior-command-driven plan → scope string inherited from the prior file (not re-derived)

## Writing: what every writer must do

1. Before writing, capture the current git state:
   ```bash
   git rev-parse --abbrev-ref HEAD  # → branch
   git rev-parse HEAD               # → head SHA
   date -u +%Y-%m-%dT%H:%M:%SZ       # → generated timestamp
   ```
2. Write the frontmatter block exactly as shown above — all six fields, no omissions.
3. Overwrite any prior file at the same path; do not append.

## Reading: what every reader must do

Before using a source file, the reader must:

### 1. Parse the frontmatter

Read the file and extract the six metadata fields. If the file does not exist, or the frontmatter is missing/malformed, tell the user to run the prior command and stop.

### 2. Determine the invocation scope

- If the user passed a scope argument (folder/file path) → that is the **invocation scope**
- If the user passed only a keyword (`review` / `coverage` / `plan`) with no path → invocation scope is the file's scope (use as-is)
- If the user passed no arguments → invocation scope is the file's scope

### 3. Hard-stop on scope mismatch

If the invocation scope is set AND does not match the file's `scope` field, STOP and tell the user:

> `.claude/tmp/{file}.md` has scope `{file_scope}` but you asked for `{invocation_scope}`.
> Re-run `/{prior_command} {invocation_scope}` first, or drop the scope argument to use the file as-is.

Do not proceed. The scope mismatch is almost always a session carryover from earlier work, and silently using stale findings is worse than stopping.

Scope comparison is literal string equality after trimming whitespace. If the user wants partial matches (e.g. `lib` to use a `lib/auth` plan), they can drop the scope argument.

### 4. Soft-warn on staleness

Print a one-line warning (but continue) for each of the following:

- **Age**: `generated` is more than 1 hour ago → `⚠ file is {N}h old`
- **Branch**: current branch ≠ file's `branch` → `⚠ file was generated on branch {file_branch}, you are now on {current_branch}`
- **HEAD**: current HEAD SHA ≠ file's `head` → `⚠ HEAD has moved since file was generated ({file_head_short} → {current_head_short})`

### 5. Print the provenance line

Before doing any work, print one line showing what's being used:

```
Using .claude/tmp/{file}.md — scope: {scope}, generated {relative time}, branch: {branch}
```

Followed by any soft warnings from step 4. Keep this to 1–3 short lines total.

## Example

A `/test-plan review` run that is about to use `.claude/tmp/test-review.md`:

```
Using .claude/tmp/test-review.md — scope: components/analytics, generated 12m ago, branch: feature/testing-commands
```

A stale run on a different branch:

```
Using .claude/tmp/test-review.md — scope: components/analytics, generated 3h ago, branch: feature/old-work
⚠ file is 3h old
⚠ file was generated on branch feature/old-work, you are now on feature/testing-commands
⚠ HEAD has moved since file was generated (d5ac2ef → 8a1f2b3)
```

A scope mismatch (hard stop, no work done):

```
.claude/tmp/test-review.md has scope `components/analytics` but you asked for `lib/auth`.
Re-run `/test-review lib/auth` first, or drop the scope argument to use the file as-is.
```

## Source Findings vs Test Findings

`/test-review` produces two linked categories of findings:

1. **Test findings** — problems with the test file (weak assertions, mock-proving, missing cases, etc). These get Keep/Rewrite/Add/Delete classifications for the test file.
2. **Source findings** — problems with the source code that the test quality issue was hiding (unhandled rejection, missing validation, absent try/catch, etc). Mock-proving tests almost always sit on top of a real source gap; the reviewer surfaces that gap rather than silently green-washing it with a test rewrite.

Every source finding is linked to at least one test-rewrite item — they share a root cause.

### Source finding classification

Each source finding carries a recommended default classification so the planner can make a principled call without re-reading the source:

| Classification | Meaning                                                                                                              | When the reviewer picks it                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fix**        | Source is genuinely broken; fix the code before writing the test.                                                    | Default. Unhandled rejections, missing input validation at a security boundary, silent catch-all blocks that swallow real errors, logic that contradicts documented intent. |
| **Document**   | Source behavior is intentional but undocumented; write the test to assert the _actual_ behavior and leave a comment. | Functions that intentionally throw for callers to handle, deliberate no-ops, legacy compatibility shims.                                                                    |
| **Skip**       | The test itself is testing the wrong thing; delete the test, do not replace it.                                      | Tests for capabilities the source never claimed, or tests that re-assert a framework/library contract.                                                                      |

The reviewer's recommendation is not binding — the plan step presents it to the user for confirmation or override.

### Structured section format

Both `/test-review` and `/test-plan` include a `## Source Findings` (review) or `## Source Decisions` (plan) section with the same per-finding structure:

```markdown
### `{source file path}:{line}` — {one-line summary}

**Linked test item**: `{test file}:{line}` — `{test name}`
**Default classification**: Fix | Document | Skip
**Reasoning**: {one paragraph — why this classification, what the source actually does, what the contract should be}
**If Fix**: {concrete source change — "add .catch(logger.error) on line 81", "wrap getItem in try/catch", etc}
**If Document**: {what the test should assert instead — the honest current behavior}
**If Skip**: {which test(s) to delete}
```

Both `/test-review`'s Source Findings and `/test-plan`'s Source Decisions blocks carry:

```markdown
**Decision**: Fix | Document | Skip ← starts as the reviewer's default
**Status**: pending | resolved | accepted ← resolved = source changed, accepted = user confirmed Document/Skip
```

**The review file is the authoritative decision-tracking record.** The user resolves findings in the review conversation after `/test-review` completes — by landing the fix inline, delegating to a subagent or separate session, or overriding the default (Document / Skip). The main agent in the review conversation updates the review's Status fields in response to user trigger phrases:

- `"fix them"` / `"fix {finding}"` → apply the default Fix inline, then flip `Status: pending` → `Status: resolved`.
- `"document {finding}"` / `"skip {finding}"` → change `Decision` and flip `Status: pending` → `Status: accepted` (no source change required).
- `"findings are fixed"` / `"sync the review"` / `"check the fixes"` → re-read the affected source ranges, verify each fix matches the `If Fix` recommendation, flip verified findings to `resolved`, leave unverified ones `pending` with a note.

`/test-plan review` refuses to run while any review finding is `pending` — **all decision-making happens at the review step**. The plan file's Source Decisions block is an audit copy of findings already `resolved` or `accepted` upstream. `/test-write` and `/test-fix` retain a hard-stop on pending decisions as defence-in-depth, but it should never trigger in normal flow because the review conversation gates everything upstream.
