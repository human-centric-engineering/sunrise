---
allowed-tools: Bash, Glob, Grep, Read, Write
description: Analyze test coverage gaps and prioritize files/folders that need tests
---

Analyze test coverage across the project or specific folders. Identifies files with no tests, low coverage, and untested critical paths. Use this to find where to focus testing effort.

**Context discipline:** This command works purely from `coverage/coverage-summary.json` and file-path information (Glob). **The main agent must NOT read source files.** Module classification and thresholds are derived from paths alone — e.g., `lib/auth/**` → auth module (90%), `app/api/**/route.ts` → API endpoint (80%). Reading source contents is unnecessary and inflates context on what should be a cheap planning step.

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

### Step 5: Classify by module criticality (path-based)

Classify each file by its **path** — do not open the file. Then apply the module threshold from `.claude/skills/testing/success-criteria.md`:

| Path pattern                                           | Module             | Threshold |
| ------------------------------------------------------ | ------------------ | --------- |
| `lib/validation/**`, `**/schemas/**`, `**/*.schema.ts` | Validation schemas | 95%+      |
| `lib/auth/**`                                          | Auth utilities     | 90%+      |
| `lib/errors/**`, `**/error-handler*`                   | Error handler      | 90%+      |
| `lib/api/**`                                           | API utilities      | 85%+      |
| `lib/db/**`, `lib/prisma/**`, `**/database/**`         | Database utilities | 85%+      |
| `lib/**` (everything else)                             | General utilities  | 85%+      |
| `app/api/**/route.ts`                                  | API endpoints      | 80%+      |
| `components/**`, `app/**/page.tsx`                     | Components         | 70%+      |

Flag files below their module-specific threshold, even if they meet the global 80%. When a path matches multiple patterns (rare), use the stricter threshold.

### Step 6: Write full analysis to file

Write the complete coverage analysis to `.claude/tmp/test-coverage.md`, overwriting any prior run. This file is the authoritative record — `/test-plan coverage` reads from it. Follow the shared protocol in `.claude/docs/test-command-file-protocol.md` — every file must start with the metadata frontmatter block.

Before writing, capture git state with Bash:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

The file format:

```markdown
---
command: test-coverage
scope: { scope string — folder paths, 'branch diff vs origin/main', or "whole project" }
mode: targeted | branch-diff
branch: { current branch }
head: { current HEAD SHA }
generated: { ISO 8601 UTC timestamp }
---

# Coverage Analysis

**Total source files scanned**: {count}
**Total test files**: {count}
**Overall coverage**: {lines}% lines, {branches}% branches, {functions}% functions

## Category A: No Tests ({count} files)

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

## Category B: Below Threshold ({count} files)

| File | Lines | Branches | Functions | Target | Gap |
| ---- | ----- | -------- | --------- | ------ | --- |

## Category C: Weak Branch Coverage ({count} files)

| File | Lines | Branches | Key Untested Branches |
| ---- | ----- | -------- | --------------------- |

## Category D: Meeting Thresholds ({count} files)

{Only list critical-module files between their module threshold and 100%}

## Summary Statistics

| Metric                   | Value                |
| ------------------------ | -------------------- |
| Files with no tests      | {count} ({percent}%) |
| Files below threshold    | {count} ({percent}%) |
| Files meeting threshold  | {count} ({percent}%) |
| Critical files uncovered | {count}              |

## Recommended Action Plan

**Sprint 1** (security-critical gaps): {files}
**Sprint 2** (business logic gaps): {files}
**Sprint 3** (coverage hardening): {files}

## Structured Findings

Consumed by `/test-plan coverage`.

### `{source file path}`

**Action**: CREATE / ADD
**Test file**: `{expected test file path}`
**Sprint**: 1 / 2 / 3
**Coverage target**: {percentage based on module}

{For CREATE files (Category A):}
**Needs**: Full test file — no existing tests
**Key behaviors to cover**: _deferred to `/test-plan coverage`_ — `/test-plan`'s fresh-analysis subagents will read the source and enumerate behaviors. Do not pre-enumerate here (that would require reading source in this command, which is explicitly out of scope).

{For ADD files (Category B/C):}
**Current coverage**: {lines}% lines, {branches}% branches
**Gap**: {what's missing — specific lines/branches}
**Needs**: Additional test cases for uncovered paths

---
```

### Step 7: Print terse summary to chat

Do NOT print the full analysis in chat. Print a short, scannable summary only.

Format:

```
## Coverage Analysis — {scope}

{N} files scanned · **{A} no tests · {B} below threshold · {C} weak branches**
Overall: {lines}% lines, {branches}% branches, {functions}% functions
Full analysis: `.claude/tmp/test-coverage.md`

### Category A: No tests ({A} files)
{Up to 3 security-critical / high-priority files, one per line, formatted: `- lib/auth/guards.ts — middleware (Auth, 90% target)`}
{If more: "(+{N} more in file)"}

### Category B: Below threshold ({B} files)
{Up to 3 worst offenders, formatted: `- lib/api/client.ts — 62% lines (target 85%, gap -23%)`}
{If more: "(+{N} more in file)"}

### Priority
Sprint 1 (security-critical): {count} files
Sprint 2 (business logic): {count} files
Sprint 3 (hardening): {count} files

Next: `/test-plan coverage` → `/test-write plan`
```

Keep chat output under ~25 lines regardless of project size.
