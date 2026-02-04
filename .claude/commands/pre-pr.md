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

Run `git diff --name-only main...HEAD -- '*.ts' '*.tsx'` to get the list of files changed on this branch. If no files changed, report "No changes to scan" and stop.

Filter out test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`) for the anti-pattern scan. Test files have different rules and are not subject to these checks.

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

### Step 4: Check .context/ documentation

If any files under `.context/` were modified, read them and check for:

- References to `NextAuth` (the project uses `better-auth`)
- References to `next-auth` (the project uses `better-auth`)
- References to Tailwind v3 patterns like `@apply` with `dark:` (the project uses Tailwind v4)
- Outdated file paths that no longer exist

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

### Documentation Check
- [ ] .context/ files: {CLEAN or issues found}

### Issues to Address
{List each issue with file path, line number, and brief description}
{Or "No issues found - ready for PR!"}
```

Mark each check with a filled checkbox `[x]` for pass or empty `[ ]` for fail.
