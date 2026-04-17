---
allowed-tools: Bash, Glob, Grep, Read, Task
description: Run pre-PR validation checklist (type-check, lint, coverage, anti-pattern scan)
---

Run a pre-PR validation checklist on the current branch. This catches common issues before opening a pull request.

## Steps

Follow these steps precisely, in order:

### Step 1: Run automated checks

Run `npm run validate` (type-check + lint + format check). Capture and report any failures.

Then run `npm run test:coverage`. This runs the full test suite and generates a coverage report at `coverage/coverage-summary.json`. Capture and report any test failures.

If either command fails, report the failures and stop. Do not proceed to the anti-pattern scan until automated checks pass.

### Step 2: Identify changed files

First, resolve the correct base ref. The local `main` branch may be stale or polluted with feature-branch commits, so **always use the remote tracking ref**:

```bash
git fetch origin main --quiet
BASE=$(git merge-base origin/main HEAD)
```

Use `$BASE` as the comparison point for all git diff commands in subsequent steps. Report the resolved base commit (short hash) in the output so reviewers can verify.

Run `git diff --name-only $BASE...HEAD` (no file filter) to get the complete list of all files changed on this branch.

From that list, build two separate sets:

- **TypeScript files** (`*.ts`, `*.tsx`) excluding test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`) — used for the anti-pattern scan in Step 4
- **Documentation files** (any path starting with `.context/`) — used for the documentation check in Step 5

If there are no TypeScript files and no documentation files, report "No changes to scan" and stop.

### Step 3: Coverage analysis for changed files

Parse `coverage/coverage-summary.json` (generated in Step 1) and filter it to only the TypeScript files identified in Step 2 (including test files this time — use the full list of changed `.ts`/`.tsx` files).

The JSON file contains per-file entries keyed by absolute path, each with `lines`, `statements`, `branches`, and `functions` objects that have a `pct` field (percentage covered). The project thresholds are **80%** for all four metrics (defined in `vitest.config.ts`).

For each changed file that appears in the coverage report:

- Extract the `pct` value for lines, branches, functions, and statements
- Flag any metric below the 80% threshold

Changed files that do **not** appear in the coverage report at all should be flagged separately as "no coverage data" — this typically means no test exercises that file. Files excluded from coverage in `vitest.config.ts` (layouts, loading states, error boundaries, type files, etc.) are exempt — do not flag these.

If no changed files have coverage data (e.g., all changes are in exempt files), report "No coverable files changed" and move on.

### Step 4: Scan for anti-patterns

Read each changed file and check for these project-specific anti-patterns:

**4a. Unsafe type assertions on structured data**
Flag `as` casts on Prisma JSON fields, API response bodies, or environment variables that are NOT accompanied by a Zod `.parse()` / `.safeParse()` or a type guard function within 5 lines. Legitimate casts (e.g., `as Record<string, unknown>` followed by a Zod parse) are fine.

**4b. API routes missing rate limiting**
Check any new or modified `route.ts` files under `app/api/` for POST, PATCH, PUT, or DELETE handlers. Flag handlers that don't call `checkRateLimit()` or `adminRateLimit()` (or use `withAuth()`/`withAdminAuth()` which include rate limiting). GET-only routes are exempt.

**4c. Duplicated auth session checks**
Flag files that manually call `auth.api.getSession()` and check the result instead of using `withAuth()` or `withAdminAuth()` from `@/lib/auth/guards`. The shared guards are the canonical pattern.

**4d. Console usage in production code**
Flag `console.log`, `console.warn`, `console.error`, or `console.info` in changed files (excluding test files). The project uses the structured logger (`@/lib/logging`). Ignore lines with `eslint-disable` comments (these are pre-approved exceptions).

**4e. Missing error or loading boundaries**
For any new `page.tsx` files added under `app/`, check that the same route segment has an `error.tsx` and `loading.tsx`. Flag missing boundaries. Route groups that share a parent `error.tsx`/`loading.tsx` are fine — check parent directories.

**4f. New code files missing tests**
For any new TypeScript files added on this branch (identified via `git diff --name-status $BASE...HEAD` — look for `A` status entries), check whether a corresponding test file exists. The project mirrors source paths under `tests/unit/` and `tests/integration/` with a `.test.ts` or `.test.tsx` suffix (e.g., `lib/security/rate-limit.ts` → `tests/unit/lib/security/rate-limit.test.ts`; `app/api/v1/users/route.ts` → `tests/integration/api/v1/users/...`). Flag new files that have no corresponding test. Exempt from this check: type declaration files (`*.d.ts`), configuration files, `loading.tsx`, `error.tsx`, `layout.tsx`, and barrel/index files that only re-export.

**4g. Direct data imports bypassing the API**
Flag non-type imports in pages, layouts, and components that pull data or constants from `lib/` modules when that data is seeded into the database and should be fetched via the API. The key indicator is importing runtime values (not just types) from modules whose data is also available through an API endpoint or is seeded into the database — e.g., importing `BUILTIN_WORKFLOW_TEMPLATES` from `@/lib/orchestration/workflows/templates` instead of fetching templates from the API. Type-only imports (`import type { ... }`) are fine — the concern is runtime coupling to data that should come through the API boundary. This enforces the same API-first separation as 4l below: components should fetch data from the API, not import it directly from server-side modules.

**4h. N+1 client-side fetches in list/table components**
Flag components (under `components/` or `app/`) that fire per-row API calls to fetch supplementary data for a list or table. The telltale pattern is a `useEffect` (or similar) that iterates over an array of items and calls `fetch()` per item — e.g., `agents.map(async (agent) => fetch(\`/api/.../\${agent.id}/budget\`))`. The correct pattern is to enrich the list API endpoint to return supplementary data inline (via Prisma `include`, `\_count`, or batch aggregates like `groupBy`), so the page makes a single HTTP request. Indicators to look for: `Promise.all(items.map(... fetch ...))`inside a`useEffect`, state shaped like `Record<string, X | null>` populated by per-item fetches, or multiple identical API calls differing only by an ID path segment. A single detail fetch (e.g., clicking a row to load its full record) is fine — this check targets bulk per-row fetches on list views.

**4i. Relative imports instead of `@/` alias**
Flag any `import` or `require` that uses a relative path (`../` or `./`) in changed files. The project mandates the `@/` path alias for all imports. The only exception is relative imports within test files that import test helpers from the same `tests/` directory — these are fine.

**4j. Unvalidated API request bodies**
Flag route handlers (in `app/api/`) that call `await request.json()` or `await request.formData()` and use the result without passing it through a Zod schema (`.parse()` or `.safeParse()`). This is distinct from 4a (which catches unsafe `as` casts) — this catches the case where there is no validation at all. The result of `request.json()` is `any`, so using it directly without validation is both a type-safety and security risk. GET handlers that only read query params via `searchParams` are exempt from this specific check (though query params should also be validated, that's covered by 4a).

**4k. Bare `fetch()` instead of `serverFetch()` for internal API calls**
Flag server components (files under `app/` without `'use client'`) and server-side `lib/` modules that call `fetch('/api/...')` or `fetch(\`/api/...\`)`instead of using`serverFetch()`from`@/lib/api/server-fetch`. The `serverFetch()`helper handles base URL resolution, auth forwarding, and error standardization. Client components that use`fetch()`for API calls are fine —`serverFetch()`is only for server-side code. Also exempt: test files and the`serverFetch` implementation itself.

**4l. Direct Prisma usage outside API routes**
Flag imports of `@/lib/prisma`, `@/lib/db`, or `@prisma/client` — and any usage of the `prisma` client (e.g., `prisma.`, `PrismaClient`) — in files outside of `app/api/`, `lib/`, `prisma/`, and `scripts/`. Pages, layouts, components, and other non-API app code must call the API (via `serverFetch()` or client fetch) rather than accessing the database directly. This enforces API-first separation of concerns so the API can be split out of the monolith in the future. Note: this check catches direct imports only, not transitive dependencies (e.g., a page importing a lib helper that internally uses Prisma). Full import-chain analysis is out of scope for this check.

### Step 5: Check .context/ documentation

This step always runs. It checks documentation that was changed on this branch AND documentation that should have been updated to reflect code changes.

**5a. Stale content check (changed docs only)**

If any `.context/` files were identified in Step 2, read them and flag:

- References to `NextAuth` or `next-auth` (the project uses `better-auth`)
- References to Tailwind v3 patterns like `@apply` with `dark:` (the project uses Tailwind v4)
- File paths referenced in the docs that no longer exist in the repository

**5b. Accuracy of changed docs against code** — if `.context/` files were changed on this branch:

- Read the changed `.context/` files and the changed TypeScript source files together
- Check that code examples, function signatures, configuration values, and described behaviours in the docs still match the actual code
- Flag any documentation that describes something different from what the code now does (e.g. a CSP directive listed in the docs but absent from the implementation, a function signature that no longer matches, a config option that was renamed or removed)

**5c. Missing or outdated documentation for code changes** — for each changed TypeScript file from Step 2, identify the relevant `.context/` documentation by mapping the code path to a documentation domain (e.g., `lib/auth/` → `.context/auth/`, `lib/security/` → `.context/security/`, `app/api/v1/admin/orchestration/` → `.context/orchestration/`, `lib/logging/` → `.context/logging/`). Use the `.context/` subdirectory names and the code file paths to infer the mapping. Then:

- Read the relevant `.context/` docs and the changed code together
- Flag documentation that describes behaviour, function signatures, configuration, or API contracts that the code changes have made inaccurate
- Flag new public functions, API endpoints, configuration options, or significant behavioural changes that are not covered by any existing `.context/` documentation
- Do NOT flag minor internal refactors, variable renames, or implementation details that don't change the external contract described in the docs

### Step 6: Output summary

Output a clear summary in this format:

```
## Pre-PR Validation Results

### Automated Checks
- [ ] Type-check: PASS / FAIL
- [ ] Lint: PASS / FAIL
- [ ] Format: PASS / FAIL
- [ ] Tests: PASS / FAIL (X passed, Y failed)

### Coverage (changed files — threshold 80%)
| File | Lines | Branches | Functions | Stmts | Status |
|------|-------|----------|-----------|-------|--------|
{One row per changed file with coverage data. Show percentages. Status = PASS if all metrics ≥ 80%, FAIL otherwise.}
{Files with no coverage data listed separately as "No coverage data (not exercised by any test)"}
{Or "No coverable files changed"}

### Anti-Pattern Scan ({N} files scanned)
- [ ] Unsafe type assertions: {count found or CLEAN}
- [ ] Missing rate limiting: {count found or CLEAN}
- [ ] Duplicated auth checks: {count found or CLEAN}
- [ ] Console usage: {count found or CLEAN}
- [ ] Missing error/loading boundaries: {count found or CLEAN}
- [ ] New files missing tests: {count found or CLEAN}
- [ ] Direct data imports bypassing API: {count found or CLEAN}
- [ ] N+1 client-side fetches: {count found or CLEAN}
- [ ] Relative imports: {count found or CLEAN}
- [ ] Unvalidated request bodies: {count found or CLEAN}
- [ ] Bare fetch() instead of serverFetch(): {count found or CLEAN}
- [ ] Direct Prisma outside API routes: {count found or CLEAN}

### Documentation Check
- [ ] Stale content in changed docs: {CLEAN or issues found}
- [ ] Changed docs accuracy: {CLEAN or issues found}
- [ ] Docs missing/outdated for code changes: {CLEAN or issues found}

### Issues to Address
{List each issue with file path, line number, and brief description}
{Or "No issues found - ready for PR!"}
```

Mark each check with a filled checkbox `[x]` for pass or empty `[ ]` for fail.
