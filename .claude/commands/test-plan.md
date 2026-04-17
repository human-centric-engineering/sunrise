---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Analyze code and produce a phased, prioritized test plan with agent batching strategy
---

Analyze code and produce a detailed, phased test plan. This is the planning step — run this before `/test-write`. The plan defines what tests are needed, how to batch agent work, and in what order (sprints/phases).

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

- Extract the structured findings from the most recent `/test-coverage` output
- These provide the file list, actions (CREATE/ADD), sprint assignments, and gap descriptions
- If folder paths are also provided, filter the coverage findings to only those folders

**If `review` keyword is present:**

- Extract the structured findings from the most recent `/test-review` output
- These provide per-file keep/rewrite/add instructions
- If folder paths are also provided, filter the review findings to only those folders

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

- Coverage CREATE → include all behaviors from coverage
- Coverage ADD gaps → merge with review's ADD items (deduplicate by scenario)
- Review REWRITE items → include as-is (coverage doesn't produce these)
- Review KEEP items → include as-is

Report the list of target files to the user.

If there are no target files, report "No files to plan tests for" and stop.

### Step 2: Read and analyze each file

For each target file, read the source file and extract:

1. **File type**: Classify as one of:
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

2. **Complexity**: Score using these factors:
   - Function count (×2 per function)
   - Uses Prisma/database (+10)
   - Uses better-auth (+8)
   - Uses external APIs/fetch (+8)
   - Uses file system (+5)
   - Side effects (×3 each)
   - Branching/conditionals (×2 each)
   - Score < 10 = **simple**, 10-24 = **medium**, 25+ = **complex**

3. **Dependencies to mock**: List external dependencies that tests would need to mock (Prisma, auth, logger, Next.js headers/cookies, fetch, etc.)

4. **Key behaviors to test**: List the main behaviors, including:
   - Happy path scenarios
   - Validation/error cases
   - Edge cases (null, empty, boundary values)
   - Security-relevant paths (auth checks, rate limiting, input sanitization)

5. **Existing test state**: Check if a corresponding test file already exists:
   - For `lib/foo/bar.ts` → check `tests/unit/lib/foo/bar.test.ts`
   - For `app/api/v1/foo/route.ts` → check `tests/unit/app/api/v1/foo/route.test.ts` and `tests/integration/...`
   - If a test file exists, read it and classify each existing test as **keep** (good), **rewrite** (weak/outdated), or note what's **missing**

6. **Incorporate prior findings**: If `/test-review` or `/test-coverage` provided findings for this file (from Step 1), merge them with the analysis above. Prior findings take precedence for keep/rewrite classifications since they've already been audited.

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

### Step 6: Output the plan

Output the plan in this format:

```
## Test Plan

**Mode**: Branch diff / Targeted / From review / From coverage
**Source**: {what input drove this plan — branch name, folder paths, or prior command}
**Target files**: {count} files to test
**Estimated complexity**: {simple count} simple, {medium count} medium, {complex count} complex
**Sprints**: {count} phases planned

---

### Sprint 1: {name — e.g., "Security-Critical Gaps"}
**Files**: {count}
**Estimated agents**: {count}
**Priority**: 1 (security-critical)

#### Agent Batch 1.1: {description — e.g., "Validation schemas (simple, no mocking)"}
| # | File | Action | Complexity | Tests to Keep | Tests to Rewrite | Tests to Add |
|---|------|--------|------------|---------------|------------------|--------------|
| 1 | `lib/validations/auth.ts` | CREATE | simple | — | — | 10+ (all schemas) |
| 2 | `lib/validations/user.ts` | CREATE | simple | — | — | 8+ (all schemas) |

{Per-file work instructions from Step 4 for each file in this batch}

#### Agent Batch 1.2: {description}
...

---

### Sprint 2: {name}
...

---

### Sprint 3: {name}
...

---

### Mocking Requirements
{List unique dependencies that need mocking across all sprints, with a note on which mock strategy to use — reference `.context/testing/mocking.md`}

### Summary

| Sprint | Files | Agents | Priority | Scope |
|--------|-------|--------|----------|-------|
| 1 | {count} | {count} | Security-critical | {brief description} |
| 2 | {count} | {count} | Core infrastructure | {brief description} |
| 3 | {count} | {count} | Coverage hardening | {brief description} |

### Notes
{Any observations about the code that affect testing strategy — e.g., tight coupling that makes testing hard, missing validation that should be added, etc.}
```

**After outputting the plan, ask the user:**

> Plan ready. Which sprint would you like to execute?
>
> - `/test-write plan` — execute Sprint 1 (recommended starting point)
> - `/test-write plan sprint 2` — execute a specific sprint
> - `/test-write plan all` — execute all sprints sequentially
>
> Or adjust the plan first if anything looks off.

Do NOT write any test files — this command only produces the plan. Use `/test-write` to execute it.
