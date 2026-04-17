---
allowed-tools: Bash, Glob, Grep, Read
description: Analyze test coverage gaps and prioritize files/folders that need tests
---

Analyze test coverage across the project or specific folders. Identifies files with no tests, low coverage, and untested critical paths. Use this to find where to focus testing effort.

## Input

$ARGUMENTS — optional scope for the analysis:

- Folder paths → scope to those folders only
- `branch` → filter to only files changed on the current branch vs `origin/main`
- No arguments → analyze the entire project

## Steps

### Step 1: Run coverage

Run the test suite with coverage:

```bash
npm run test:coverage 2>&1
```

If tests fail, report the failures but continue with coverage analysis for the files that did get covered.

### Step 2: Parse coverage data

Read `coverage/coverage-summary.json`. This contains per-file entries keyed by absolute path, each with `lines`, `statements`, `branches`, and `functions` objects that have a `pct` field.

**If `$ARGUMENTS` is `branch`:**

- Resolve the base ref:
  ```bash
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
  ```
- Get changed files: `git diff --name-only $BASE...HEAD`
- Filter coverage data to only those files

**If `$ARGUMENTS` contains folder paths:**

- Filter coverage data to only files under those paths

**If no arguments:**

- Use the full coverage report (entire project)

### Step 3: Find files with NO tests

Scan the source directories for `.ts` and `.tsx` files:

- `lib/**/*.ts` — utilities, API helpers, auth, security, database
- `app/api/**/*.ts` — API route handlers
- `app/**/page.tsx` — page components
- `components/**/*.tsx` — UI components

Exclude from this scan:

- Test files (`*.test.*`, `*.spec.*`)
- Type declaration files (`*.d.ts`)
- Configuration files
- `layout.tsx`, `loading.tsx`, `error.tsx` (low-value to unit test)
- Barrel/index files that only re-export
- Files explicitly excluded in `vitest.config.ts` coverage config

For each source file, check if:

1. A corresponding test file exists in `tests/unit/` or `tests/integration/`
2. The file appears in the coverage report (meaning some test exercises it, even without a dedicated test file)

Files that fail both checks are "completely untested."

### Step 4: Categorize and prioritize

Group all source files into these categories:

**Category A — No tests at all** (highest priority):
Files with no corresponding test file AND no coverage data. These are blind spots.

**Category B — Below threshold** (high priority):
Files with coverage data but below the project threshold (80% lines). Sort by coverage percentage ascending (worst first).

**Category C — Missing branch coverage** (medium priority):
Files meeting line coverage but with branch coverage below 75%. These often indicate untested error paths.

**Category D — Meeting thresholds** (low priority):
Files meeting all coverage thresholds. Only flag these if they're in a critical module (auth, security) and below 90%.

### Step 5: Classify by module criticality

Apply the project's coverage thresholds from `.claude/skills/testing/success-criteria.md`:

| Module             | Threshold |
| ------------------ | --------- |
| Validation schemas | 95%+      |
| Auth utilities     | 90%+      |
| Error handler      | 90%+      |
| API utilities      | 85%+      |
| Database utilities | 85%+      |
| General utilities  | 85%+      |
| API endpoints      | 80%+      |
| Components         | 70%+      |

Flag files that are below their module-specific threshold, even if they meet the global 80%.

### Step 6: Output the analysis

```
## Coverage Analysis

**Scope**: {Entire project / Folders: {list}}
**Total source files scanned**: {count}
**Total test files**: {count}
**Overall coverage**: {lines}% lines, {branches}% branches, {functions}% functions

### Category A: No Tests ({count} files)
These files have zero test coverage — no dedicated test file and no indirect coverage.

**Security-critical (fix immediately):**
| File | Type | Module | Required Threshold |
|------|------|--------|--------------------|
| `lib/auth/guards.ts` | middleware | Auth | 90% |

**Business logic (fix before next release):**
| File | Type | Module | Required Threshold |
|------|------|--------|--------------------|

**UI/Other (backlog):**
| File | Type | Module | Required Threshold |
|------|------|--------|--------------------|

### Category B: Below Threshold ({count} files)
These files have tests but don't meet coverage targets.

| File | Lines | Branches | Functions | Target | Gap |
|------|-------|----------|-----------|--------|-----|
| `lib/api/client.ts` | 62% | 45% | 70% | 85% | -23% lines |

### Category C: Weak Branch Coverage ({count} files)
Line coverage is OK but branch coverage suggests untested error/edge paths.

| File | Lines | Branches | Key Untested Branches |
|------|-------|----------|-----------------------|
{If possible, identify which branches are untested by reading the source}

### Category D: Meeting Thresholds ({count} files)
{Only list files in critical modules (auth, security, validation) that are between their module threshold and 100% — these are candidates for hardening}

### Summary Statistics

| Metric | Value |
|--------|-------|
| Files with no tests | {count} ({percent}%) |
| Files below threshold | {count} ({percent}%) |
| Files meeting threshold | {count} ({percent}%) |
| Critical files uncovered | {count} |

### Recommended Action Plan

**Sprint 1** (security-critical gaps):
{List files, estimated complexity, suggested approach}

**Sprint 2** (business logic gaps):
{List files, estimated complexity, suggested approach}

**Sprint 3** (coverage hardening):
{List files needing branch coverage improvement}

### Structured Findings

The following structured findings can be consumed by `/test-plan coverage`:

{For each file needing work, output this block:}
#### `{source file path}`

**Action**: CREATE / ADD
**Test file**: `{expected test file path}`
**Sprint**: 1 (security-critical) / 2 (business logic) / 3 (coverage hardening)
**Coverage target**: {percentage based on module}

{For CREATE files (Category A — no tests):}
**Needs**: Full test file — no existing tests
**Key behaviors to cover**: {list main functions/exports and their purposes from reading the source}

{For ADD files (Category B/C — below threshold):}
**Current coverage**: {lines}% lines, {branches}% branches
**Gap**: {what's missing — e.g., "error handling branches at lines 45-52 untested", "else clause at line 78 never hit"}
**Needs**: Additional test cases for uncovered paths

---

### Next Steps

To address these gaps:
1. `/test-plan coverage` — create a phased execution plan from these findings (recommended)
2. `/test-plan {folder}` — plan tests for a specific module
3. `/test-plan {file paths}` — plan tests for specific files

Then `/test-write plan` to execute.
```
