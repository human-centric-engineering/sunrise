---
allowed-tools: Bash, Glob, Grep, Read, Task
description: Run pre-PR validation checklist (type-check, lint, tests, anti-pattern scan)
---

Run a pre-PR validation checklist on the current branch. This catches common issues before opening a pull request.

## Steps

Follow these steps precisely, in order:

### Step 1: Run automated checks

Run `npm run validate` (type-check + lint + format check). Capture and report any failures.

Then run `npm run test`. Capture and report any failures.

If either command fails, report the failures and stop. Do not proceed to the anti-pattern scan until automated checks pass.

### Step 2: Identify changed files

Run `git diff --name-only main...HEAD` (no file filter) to get the complete list of all files changed on this branch.

From that list, build two separate sets:

- **TypeScript files** (`*.ts`, `*.tsx`) excluding test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`) — used for the anti-pattern scan in Step 3
- **Documentation files** (any path starting with `.context/`) — used for the documentation check in Step 4

If there are no TypeScript files and no documentation files, report "No changes to scan" and stop.

### Step 3: Scan for anti-patterns

Read each changed file and check for these project-specific anti-patterns:

**3a. Unsafe type assertions on structured data**
Flag `as` casts on Prisma JSON fields, API response bodies, or environment variables that are NOT accompanied by a Zod `.parse()` / `.safeParse()` or a type guard function within 5 lines. Legitimate casts (e.g., `as Record<string, unknown>` followed by a Zod parse) are fine.

**3b. API routes missing rate limiting**
Check any new or modified `route.ts` files under `app/api/` for POST, PATCH, PUT, or DELETE handlers. Flag handlers that don't call `checkRateLimit()` or `adminRateLimit()` (or use `withAuth()`/`withAdminAuth()` which include rate limiting). GET-only routes are exempt.

**3c. Duplicated auth session checks**
Flag files that manually call `auth.api.getSession()` and check the result instead of using `withAuth()` or `withAdminAuth()` from `@/lib/auth/guards`. The shared guards are the canonical pattern.

**3d. Console usage in production code**
Flag `console.log`, `console.warn`, `console.error`, or `console.info` in changed files (excluding test files). The project uses the structured logger (`@/lib/logging`). Ignore lines with `eslint-disable` comments (these are pre-approved exceptions).

**3e. Missing error or loading boundaries**
For any new `page.tsx` files added under `app/`, check that the same route segment has an `error.tsx` and `loading.tsx`. Flag missing boundaries. Route groups that share a parent `error.tsx`/`loading.tsx` are fine — check parent directories.

**3f. New code files missing tests**
For any new TypeScript files added on this branch (identified via `git diff --name-status main...HEAD` — look for `A` status entries), check whether a corresponding test file exists. The project mirrors source paths under `tests/unit/` and `tests/integration/` with a `.test.ts` or `.test.tsx` suffix (e.g., `lib/security/rate-limit.ts` → `tests/unit/lib/security/rate-limit.test.ts`; `app/api/v1/users/route.ts` → `tests/integration/api/v1/users/...`). Flag new files that have no corresponding test. Exempt from this check: type declaration files (`*.d.ts`), configuration files, `loading.tsx`, `error.tsx`, `layout.tsx`, and barrel/index files that only re-export.

**3g. Direct data imports bypassing the API**
Flag non-type imports in pages, layouts, and components that pull data or constants from `lib/` modules when that data is seeded into the database and should be fetched via the API. The key indicator is importing runtime values (not just types) from modules whose data is also available through an API endpoint or is seeded into the database — e.g., importing `BUILTIN_WORKFLOW_TEMPLATES` from `@/lib/orchestration/workflows/templates` instead of fetching templates from the API. Type-only imports (`import type { ... }`) are fine — the concern is runtime coupling to data that should come through the API boundary. This enforces the same API-first separation as 3h below: components should fetch data from the API, not import it directly from server-side modules.

**3h. Direct Prisma usage outside API routes**
Flag imports of `@/lib/prisma`, `@/lib/db`, or `@prisma/client` — and any usage of the `prisma` client (e.g., `prisma.`, `PrismaClient`) — in files outside of `app/api/`, `lib/`, `prisma/`, and `scripts/`. Pages, layouts, components, and other non-API app code must call the API (via `serverFetch()` or client fetch) rather than accessing the database directly. This enforces API-first separation of concerns so the API can be split out of the monolith in the future. Note: this check catches direct imports only, not transitive dependencies (e.g., a page importing a lib helper that internally uses Prisma). Full import-chain analysis is out of scope for this check.

### Step 4: Check .context/ documentation

This step always runs. It checks documentation that was changed on this branch AND documentation that should have been updated to reflect code changes.

**4a. Stale content check (changed docs only)**

If any `.context/` files were identified in Step 2, read them and flag:

- References to `NextAuth` or `next-auth` (the project uses `better-auth`)
- References to Tailwind v3 patterns like `@apply` with `dark:` (the project uses Tailwind v4)
- File paths referenced in the docs that no longer exist in the repository

**4b. Accuracy of changed docs against code** — if `.context/` files were changed on this branch:

- Read the changed `.context/` files and the changed TypeScript source files together
- Check that code examples, function signatures, configuration values, and described behaviours in the docs still match the actual code
- Flag any documentation that describes something different from what the code now does (e.g. a CSP directive listed in the docs but absent from the implementation, a function signature that no longer matches, a config option that was renamed or removed)

**4c. Missing or outdated documentation for code changes** — for each changed TypeScript file from Step 2, identify the relevant `.context/` documentation by mapping the code path to a documentation domain (e.g., `lib/auth/` → `.context/auth/`, `lib/security/` → `.context/security/`, `app/api/v1/admin/orchestration/` → `.context/orchestration/`, `lib/logging/` → `.context/logging/`). Use the `.context/` subdirectory names and the code file paths to infer the mapping. Then:

- Read the relevant `.context/` docs and the changed code together
- Flag documentation that describes behaviour, function signatures, configuration, or API contracts that the code changes have made inaccurate
- Flag new public functions, API endpoints, configuration options, or significant behavioural changes that are not covered by any existing `.context/` documentation
- Do NOT flag minor internal refactors, variable renames, or implementation details that don't change the external contract described in the docs

### Step 5: Output summary

Output a clear summary in this format:

```
## Pre-PR Validation Results

### Automated Checks
- [ ] Type-check: PASS / FAIL
- [ ] Lint: PASS / FAIL
- [ ] Format: PASS / FAIL
- [ ] Tests: PASS / FAIL (X passed, Y failed)

### Anti-Pattern Scan ({N} files scanned)
- [ ] Unsafe type assertions: {count found or CLEAN}
- [ ] Missing rate limiting: {count found or CLEAN}
- [ ] Duplicated auth checks: {count found or CLEAN}
- [ ] Console usage: {count found or CLEAN}
- [ ] Missing error/loading boundaries: {count found or CLEAN}
- [ ] New files missing tests: {count found or CLEAN}
- [ ] Direct data imports bypassing API: {count found or CLEAN}
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
