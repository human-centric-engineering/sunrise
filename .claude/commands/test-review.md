---
allowed-tools: Bash, Glob, Grep, Read
description: Audit test quality — find weak assertions, happy-path-only coverage, mock-proving tests, and missing edge cases
---

Review existing tests for quality issues. Identifies tests that give false confidence — happy-path-only coverage, tests that just prove mocks work, weak assertions, and missing edge cases.

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

### Step 2: Read source and test files

For each test file, also read the corresponding source file it tests. You need both to assess quality — a test can only be evaluated against the code it's supposed to verify.

### Step 3: Audit each test file

For each test file, check for the following quality issues. Classify each finding as **critical** (test gives false confidence), **warning** (test is weak but not misleading), or **info** (style improvement).

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

### Step 4: Output the review

Output the review in this format:

```
## Test Quality Review

**Files reviewed**: {count} test files for {count} source files
**Mode**: Branch diff / Targeted

### Summary
- **Critical issues**: {count} — tests give false confidence, fix before merging
- **Warnings**: {count} — tests are weak, improve when possible
- **Info**: {count} — style improvements, low priority

### File: `{test file path}` → `{source file path}`

**Overall quality**: Good / Acceptable / Needs Work / Poor

#### Critical Issues
{numbered list with:}
1. **{Issue type}** (line {N}): {description}
   - **Current**: `{the weak/wrong assertion or missing test}`
   - **Should be**: `{what should be tested instead}`

#### Warnings
{numbered list}

#### Info
{numbered list}

#### Missing Test Cases
Tests that should be added to this file:
- [ ] {description of missing test — e.g., "should return 401 when session is expired"}
- [ ] {description}

---
{repeat for each file}

### Overall Assessment

**Ready for merge**: Yes / No (fix critical issues first)

**Priority fixes** (do these first):
1. {file}: {most important fix}
2. {file}: {second most important fix}

**Improvement suggestions** (do these when possible):
- {suggestion}

### Structured Findings

The following findings can be consumed by `/test-plan review`:

{For each file with issues, output this block:}
#### `{source file path}` → `{test file path}`

**Keep** (good tests, do not modify):
- `{test name}` (line {N})

**Rewrite** (fix these existing tests):
- `{test name}` (line {N}) — {reason: weak assertion / mock-proving / outdated / name mismatch}. Should: {what the rewritten test should assert}

**Add** (new test cases needed):
- {scenario description} — {why: untested error path / missing edge case / uncovered branch at source line N}

---

### Next Steps

To fix these issues:
1. `/test-plan review` — create an execution plan from these findings
2. `/test-write plan` — execute the plan
```

### Step 5: Offer to fix

After presenting the review, ask:

> Would you like me to fix these issues? Run `/test-plan review` to create an execution plan, then `/test-write plan` to execute it.
