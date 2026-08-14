---
allowed-tools: Bash, Glob, Grep, Read, Task
description: Run pre-PR validation checklist (type-check, lint, coverage, anti-pattern scan)
---

Run a pre-PR validation checklist on the current branch. This catches common issues before opening a pull request.

## Steps

Follow these steps precisely, in order:

### Step 1: Run automated checks

Run `npm run validate` (CHANGELOG structure + type-check + lint + format (Prettier + Prisma)). Capture and report any failures.

`validate` runs the CHANGELOG check **first** and short-circuits on failure, so a structural problem in `CHANGELOG.md` will report as a failure with nothing after it — that is the check working, not the type-check being skipped. Fix it and re-run rather than working around it; the rules and their reasoning are in `scripts/ci/changelog-structure.ts`. Note the history rule needs `origin/main`, so run `git fetch origin main` first if the local ref is stale.

Then run `npm run test:coverage`. This runs the full test suite and generates a coverage report at `coverage/coverage-summary.json`. Capture and report any test failures.

If either command fails, report the failures and stop. Do not proceed to the anti-pattern scan until automated checks pass.

**Migration drift check (DB objects Prisma can't model).** Only if this branch touched `prisma/`:

```bash
git fetch origin main --quiet
git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD | grep -qE '^prisma/(migrations|schema)/' && echo RUN || echo SKIP
```

If `SKIP`, record "Migration drift: N/A (no prisma/ changes)" and move on. If `RUN`, run `npm run db:drift-check` (probes your local dev DB for the raw-SQL objects the schema can't model — pgvector HNSW indexes, the GIN/tsvector search index, partial-unique indexes, CHECK constraints; see `.context/database/prisma-unmodelled-objects.md`). Interpret the **exit code**:

- **0** — PASS.
- **1** — FAIL: a migration on this branch dropped one of these objects. This is the `prisma migrate dev` footgun — it diffs the schema against the shadow DB and silently emits `DROP INDEX`/`DROP CONSTRAINT` for anything it can't represent, and `migrate dev` already applied that DROP to your local DB. **Stop and report.** Fix: edit the offending migration to remove the spurious `DROP` (re-add a `CREATE … IF NOT EXISTS` if needed), and re-author migrations on these tables with `prisma migrate dev --create-only` so the DROP is reviewed before it's ever applied.
- **2** — SKIPPED (local DB unreachable). Record "Migration drift: SKIPPED (start your dev DB to enable)" — do **not** fail the run on this.

### Step 1b: Resolve the base, then inspect the lockfile and public surface

**Resolve the base ref here, before either check.** Both default to the merge
base with `origin/main`, and neither fetches — so on a stale ref they compare
against history that has moved on: `check:exports` attributes other people's
new symbols to this branch, and `check:lockfile` can exit 1 on a metadata loss
`main` already carries. The repo rule is "always use the remote tracking ref";
this is where it has to happen, because Step 2's early exit ("no TypeScript
files → stop") would skip a lockfile-only PR entirely.

```bash
git fetch origin main --quiet
BASE=$(git merge-base origin/main HEAD)
```

Reuse `$BASE` in Step 2 rather than resolving it twice.

**Lockfile** — if `package-lock.json` **or `package.json`** is in the diff
(`git diff --name-only $BASE...HEAD`). `package.json` matters because the
`overrides` rule reads that file at both revisions: an override that tightens a
range npm already satisfied changes nothing in the lockfile, so keying on the
lockfile alone would skip it.

```bash
npm run check:lockfile -- --base "$BASE"
```

Exit 1 means something needs a decision: platform metadata (`libc`/`os`/`cpu`)
lost — including across a hoist — or `overrides` changed (adding, changing OR
removing an entry). Lost metadata is the one that has actually bitten (#571).
The cause is almost always **npm below 11.11.0**, which deletes `libc` from
every entry it writes on every platform; check `npm -v`, then repair with `npm
run fix:lockfile-libc` and re-run this.

**Downgrades do not fail this check** — neither transitive nor direct. They are
reported, direct ones in their own block. The direct rule used to gate; over 134
lockfile commits it fired twice, on two deliberate pins, while
`dependency-review` fails any PR landing on a KNOWN-vulnerable version, which is
the actual risk (#584). So a run that prints "moved BACKWARDS" and still exits 0
is the tool working, not a bug. **On a private fork `dependency-review` is
skipped**, so read that block yourself rather than assuming something enforced
it.

Note the all-clear says "no version or platform-metadata change", not
"unchanged": these rules do not read `dev`, `resolved`, `integrity` or `link`,
so a `dependencies` ↔ `devDependencies` move is not something they can see.

Metadata _gained_ is reported and never gates — a package becoming more precise
is not a risk. It is printed because the #571 repair changed nothing but `libc`
on 101 packages, and a check that called that "no platform-metadata change"
would be describing the one thing the PR did as nothing at all.

**Public surface** — always:

```bash
npm run check:exports -- --base "$BASE"
```

Reports symbols added, removed or renamed on any `lib/**/index.ts` barrel.
Adding an export is normal, so a change here is **not** a failure — but it
exits 1 for an unusable `--base` or when it finds no barrels at all (which is
what happens if it is run from anywhere but the repo root). Treat exit 1 as a
wiring problem to fix, not as a finding about the branch.

It exists so step 5d's question gets asked from the surface rather than from a
path list — the list missed `normalizeRootRelativePath` on `@/lib/security` in
#506. **Anything it prints should have a CHANGELOG entry, and a removal or
rename is breaking for any fork importing it.**

Record both outputs in the summary.

### Step 2: Identify changed files

`$BASE` was already resolved in Step 1b, from the remote tracking ref — the local `main` branch may be stale or polluted with feature-branch commits. Reuse it; do not re-resolve:

```bash
echo "$BASE"   # resolved in Step 1b
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

**4f. Changed code files missing tests**
For any TypeScript files added OR modified on this branch (identified via `git diff --name-status $BASE...HEAD` — `A` or `M` status entries), check whether a corresponding test file exists. The project mirrors source paths under `tests/unit/` and `tests/integration/` with a `.test.ts` or `.test.tsx` suffix (e.g., `lib/security/rate-limit.ts` → `tests/unit/lib/security/rate-limit.test.ts`; `app/api/v1/users/route.ts` → `tests/integration/api/v1/users/...`). Flag changed files that have no corresponding test. Also accept co-located parent-directory tests for route files under dynamic segments (e.g., tests for `app/api/v1/foo/[id]/route.ts` may live in `tests/unit/app/api/v1/foo/route.test.ts`). A modified source file with no corresponding test is the same completeness gap as a newly added one — flag both. Exempt from this check: type declaration files (`*.d.ts`), configuration files, `loading.tsx`, `error.tsx`, `layout.tsx`, and barrel/index files that only re-export.

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

**4m. Hand-rolled `next/navigation` router mocks**
Flag any router object written out by hand instead of built with `createMockRouter()` from `@/tests/types/mocks`. **Run these repo-wide, not over the diff** — both invariants are currently zero, so a whole-repo count is the check, and a diff-scoped one would be blind to every pre-existing violation until someone happened to re-touch those exact lines. That blindness is not hypothetical: the first version of this check was diff-scoped and could not see the 23 files it was written to catch.

```bash
grep -rnE "as unknown as ReturnType<typeof useRouter>" tests/ \
  --include='*.ts' --include='*.tsx' | grep -vE ':[[:space:]]*\*'

python3 - <<'EOF'
import pathlib, re, sys

SIX = {'push', 'replace', 'refresh', 'back', 'forward', 'prefetch'}
KEY = re.compile(r'([A-Za-z_$][\w$]*)\s*:')
hits = []

# Anchor on `prefetch:` — any complete router literal must contain it — then
# brace-match outwards. Anchoring on a key rather than on a surrounding syntax
# form is what makes this independent of how the literal happens to be written.
for path in sorted(pathlib.Path('tests').rglob('*.ts*')):
    if path.name.endswith('.d.ts') or str(path) == 'tests/types/mocks.ts':
        continue  # the factory's own definition necessarily matches
    src = path.read_text()
    for anchor in re.finditer(r'\bprefetch\s*:', src):
        depth, start = 0, None
        for i in range(anchor.start(), -1, -1):
            if src[i] == '}':
                depth += 1
            elif src[i] == '{':
                if depth == 0:
                    start = i
                    break
                depth -= 1
        if start is None:
            continue
        depth, end = 0, None
        for i in range(start, len(src)):
            if src[i] == '{':
                depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is None:
            continue
        body = src[start + 1 : end]
        keys, d = set(), 0
        for j, ch in enumerate(body):
            if ch in '{[(':
                d += 1
            elif ch in '}])':
                d -= 1
            elif d == 0:
                m = KEY.match(body, j)
                if m and (j == 0 or not (body[j - 1].isalnum() or body[j - 1] in '_$.')):
                    keys.add(m.group(1))
        if keys >= SIX and 'createMockRouter' not in body:
            hits.append(f'{path}:{src.count(chr(10), 0, start) + 1}')

print('\n'.join(sorted(set(hits))) or 'CLEAN')
sys.exit(1 if hits else 0)
EOF
```

The grep must print **nothing**; the Python check must print **`CLEAN`** and exit 0. Any file path from either is a finding.

The **cast** is always wrong: `AppRouterInstance` gains required members between Next minors, and a double cast does not satisfy the new member — it hides that the mock is missing it, so the literal keeps compiling while the component receives an incomplete router. `tests/types/mocks.ts` is deliberately **not** excluded from this one: the comment filter already handles the JSDoc mentions, and a real cast added there (say, by a fork extending the factory) is exactly what needs catching.

The **six-member literal** means the author intended a complete router, so it should use the factory. A minimal stub (`push`/`replace` only, for a component that reads nothing else) is fine and deliberately not flagged.

**Why the scanner is shaped this way — every clause is a bug it already had.** It brace-matches outward from a key instead of matching a syntax form, because a form-matching regex saw `useRouter: vi.fn(() => ({…}))` and silently missed `useRouter: () => ({…})` — 23 files' worth. It parses keys without line anchors, because a line-anchored version reported CLEAN on a single-line six-member literal, which Prettier at `printWidth: 100` will never reflow into view. It globs `*.ts*` rather than `*.test.ts*`, because the narrower glob could not see `tests/setup.ts` — the single highest-risk file, and the one the docs name as such. And anchoring on a key rather than on `useRouter` is what lets it catch the hoisted `const mockRouter = {…}; useRouter: () => mockRouter` form.

If you change this scanner, re-test it against those four shapes before trusting a CLEAN.

Nothing type-checks a `vi.mock` factory, so neither form fails the build — this scan is the only thing that catches them. See `.context/testing/mocking.md`.

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

**5d. CHANGELOG hygiene — public-surface changes without a CHANGELOG entry**

The Sunrise CHANGELOG is intentionally curated to the public surface defined in [`VERSIONING.md`](../../VERSIONING.md#public-surface-contract-tight-definition). PRs that change the public surface should add a bullet to `CHANGELOG.md`'s `[Unreleased]` section as part of the same PR. PRs that don't touch the public surface (internal refactors, tests, docs, chores) deliberately do NOT belong in the CHANGELOG and should NOT be flagged here.

For each changed file from Step 2, decide whether it touches the public surface using these path heuristics (the "Covered" list in `VERSIONING.md`):

- **Named seam files** — flag if any of these change:
  - `lib/app/capabilities.ts`, `lib/app/admin-nav.ts`, `lib/app/env.ts`, `lib/app/rate-limit.ts`, `lib/app/db-drift.ts` (registry entry points)
  - `lib/db/drift-probes.ts` (drift-probe primitives + registry consumed by `lib/app/db-drift.ts`)
  - `lib/privacy/erasure-hooks.ts` (erasure-hook registry)
  - `lib/tenancy/client.ts`, anything referencing the `TENANCY_MODE` env (tenancy seam)
  - `eslint.config.mjs` blocks scoped to `lib/app/**` (app-boundary configuration)
- **Documented public APIs** — flag if any of these change:
  - `lib/auth/guards.ts` (withAuth / withAdminAuth signatures)
  - `lib/api/responses.ts` (successResponse / errorResponse envelope)
  - `lib/api/server-fetch.ts` (serverFetch contract)
  - `lib/logging/index.ts` and `lib/logging/types.ts` (logger surface)
  - Anything under `app/api/v1/admin/orchestration/**` (orchestration admin API surface — see `.context/api/orchestration-endpoints.md`)
- **Published Prisma model interfaces** — flag if `prisma/schema/` files change models the orchestration admin API exposes (`User`, `Ai*` models — see `.context/orchestration/admin-api.md`). Do NOT flag if only an `app.prisma` model changes — that file is fork-reserved and ships empty upstream, so a core PR touching it is itself worth questioning.
- **The CHANGELOG / VERSIONING contract itself** — flag if `VERSIONING.md` or `CHANGELOG.md` is removed or has its `[Unreleased]` section deleted without a release-rename.

**The path list is a floor, not the answer.** `npm run check:exports` from Step 1b answers the real question — _did the set of importable symbols change?_ — and it catches seams the list has never heard of. Treat any barrel change it reported as a public-surface change here, whether or not the file appears above.

If ANY public-surface path above is in the diff, OR Step 1b reported a barrel export change, AND `CHANGELOG.md` is NOT in the diff, flag it as: `Public-surface change without CHANGELOG entry — intentional? See VERSIONING.md "Covered" list.` Include the specific files that triggered the flag.

If `CHANGELOG.md` IS in the diff, the check passes regardless of what was added (the agent has already made the call; trust it).

If no public-surface paths are in the diff, the check is silent (correct — most PRs are internal and should not have a CHANGELOG entry).

This check is a **reminder, not a gate**. The agent reads the flag and decides; mechanical checks can't tell whether a `lib/auth/guards.ts` edit changed behaviour the public depends on or was an internal type tweak.

### Step 6: Output summary

Output a clear summary in this format:

```
## Pre-PR Validation Results

### Automated Checks
- [ ] CHANGELOG structure: PASS / FAIL
- [ ] Type-check: PASS / FAIL
- [ ] Lint: PASS / FAIL
- [ ] Format: PASS / FAIL
- [ ] Tests: PASS / FAIL (X passed, Y failed)
- [ ] Migration drift (Prisma-unmodelled objects): PASS / FAIL / SKIPPED / N/A
- [ ] Lockfile: PASS / FAIL / N/A (no `package-lock.json` change)
- [ ] Public surface (barrel exports): {symbols added/removed, NO CHANGE, or FAIL (wiring — see Step 1b)}

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
- [ ] Changed files missing tests: {count found or CLEAN}
- [ ] Direct data imports bypassing API: {count found or CLEAN}
- [ ] N+1 client-side fetches: {count found or CLEAN}
- [ ] Relative imports: {count found or CLEAN}
- [ ] Unvalidated request bodies: {count found or CLEAN}
- [ ] Bare fetch() instead of serverFetch(): {count found or CLEAN}
- [ ] Direct Prisma outside API routes: {count found or CLEAN}
- [ ] Hand-rolled router mocks: {count found or CLEAN}

### Documentation Check
- [ ] Stale content in changed docs: {CLEAN or issues found}
- [ ] Changed docs accuracy: {CLEAN or issues found}
- [ ] Docs missing/outdated for code changes: {CLEAN or issues found}
- [ ] CHANGELOG hygiene (public-surface changes): {CLEAN or N/A (no public-surface change) or "{N} file(s) touched the public surface without a CHANGELOG entry"}

### Issues to Address
{List each issue with file path, line number, and brief description}
{Or "No issues found - ready for PR!"}
```

Mark each check with a filled checkbox `[x]` for pass or empty `[ ]` for fail.
