---
allowed-tools: Bash, Glob, Grep, Read, Write, Agent
description: Analyze code and produce a phased, prioritized test plan with agent batching strategy
---

Analyze code and produce a detailed, phased test plan. This is the planning step — run this before `/test-write`. The plan defines what tests are needed, how to batch agent work, and in what order (sprints/phases).

**Context discipline:** When consuming a prior `/test-review` or `/test-coverage` file, **trust its findings** — do not re-read source files to "verify" them; the reviewer already did that work. Only read source files in fresh-analysis mode (branch-diff or direct folder/file arg), and for 4+ files delegate the per-file analysis to parallel Sonnet subagents.

**Test type:** the plan covers BOTH unit and integration tests. A single source file (typically an API route under `app/api/**`) may need a unit test, an integration test, or both. Type is detected per plan item from the test path: `tests/integration/**` → integration; everything else → unit. When a route handler has no existing test, the planner proposes one item per appropriate type (see Step 2b).

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

- Read `.claude/tmp/test-coverage.md` and follow the reader protocol in `.claude/docs/test-command-file-protocol.md`:
  1. Parse the frontmatter metadata.
  2. Hard-stop if the invocation scope disagrees with the file's scope.
  3. Soft-warn on age >1h, branch change, or HEAD change.
  4. Print the provenance line before proceeding.
- If the file does not exist, tell the user to run `/test-coverage` first and stop.
- Use the `## Structured Findings` section: file list, actions (CREATE/ADD), sprint assignments, gap descriptions.

**If `review` keyword is present:**

- Resolve the review file under `.reviews/`:
  - `review` with an optional scope arg (e.g. `review lib/auth`) — compute slug (`lib/auth` → `lib-auth`); look for `.reviews/tests-{slug}.md`.
  - `review` alone — pick the most recently modified `.reviews/tests-*.md` by mtime.
  - If no matching report exists, tell the user to run `/test-review [scope]` first and stop.
- Print a provenance line (`Review: .reviews/tests-{slug}.md — {age} old · branch {branch} · HEAD {head-short}`).
- Soft-warn on age >1h; hard-pause on age >24h OR branch/HEAD drift against the review's metadata — the user must explicitly continue.
- Parse the report:
  - `## Critical Findings (90–100)` and `## Important Findings (80–89)` — assign continuous 1-based indices.
  - `## Source Findings` — assign `S1, S2, …`.
  - Dependency map: any finding whose `Suggested fix` mentions "Source Finding N" / "Depends on Source Finding N" depends on the matching `S{N}`.

**Source finding gate (review mode only, runs inline during Step 1):**

New reviews are confidence-scored reports, not state machines — there is no `Status: pending/resolved/accepted`. Instead, the planner surfaces each referenced source finding to the user once, captures the decision, and carries it into the plan.

For each source finding referenced by one or more selected test findings, ask:

```
### Source Finding S{N} — `{file}:{line}` (confidence {conf})

**Issue:** {issue paragraph}
**Evidence:** {evidence}
**Suggested refactor:** {refactor snippet or description}
**Blast radius:** {blast line}
**Depended on by:** findings {list of indices}

Action for this source finding? (fix / document / skip)
- `fix` — include the refactor in the plan's Source Decisions block; dependent test findings assume the refactor has landed when /test-write executes.
- `document` — leave the source as-is; dependent tests assert the CURRENT behaviour and get a `// SOURCE DECISION: Document` annotation.
- `skip` — drop the dependent test findings from the plan entirely.
```

Record the user's decision (`fix` / `document` / `skip`) against each source finding. If the user picks `skip`, drop every dependent finding from the plan's work list before continuing to Step 2.

If every selected test finding got dropped via `skip`, stop with: `Every selected finding depends on a source finding you skipped. Nothing to plan.`

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

- Coverage CREATE → include all behaviors from coverage.
- Coverage ADD gaps → merge with review findings classified as `Add` (deduplicate by scenario).
- Review findings → classify by category (see Step 2a for the rules), then include verbatim.
- Review **Source Findings** with a `fix` decision → lift into a Source Decisions block (see Step 5.5). `document` / `skip` decisions flow into per-test rewrite strategy and don't appear in the audit block.

Report the list of target files to the user.

If there are no target files, report "No files to plan tests for" and stop.

### Step 2: Analyze each file

The analysis strategy depends on where the file list came from:

#### Step 2a: From a prior review/coverage file (`review` / `coverage` modes)

**Do NOT re-read source files** to "verify" the prior command's findings. The reviewer / coverage analyzer already read them. Use those findings directly:

- **Review findings** — each confidence-scored finding at `{testFile}:{line}` maps to one plan item. Classify by the finding's `Category`:
  - `Coverage Completeness` → **Add** (a missing test case).
  - `Assertion Quality` / `Mock Realism` / `Test-Code Alignment` / `Brittleness & Structure` → **Rewrite** (fix an existing test at the named line).
  - If two findings target the same test at the same line, merge into one Rewrite item (record both concerns in the "why" field).
  - **Carry the finding's `TYPE` (unit | integration) onto the plan item.** Review reports emit `TYPE: unit | integration` per finding; the planner preserves this so `/test-write` dispatches each item to an appropriately-scoped test-engineer run. Detect the type from the test path if a review report predates the TYPE field.
- **Source Findings** — decision captured in Step 1's gate: `fix` → Source Decisions (Step 5.5); `document` → per-test Rewrite with a documenting comment; `skip` → test finding already dropped upstream.
- **Coverage gaps** → Add items with the gap description as the "why". Type is inferred from the coverage item's target test path (or target source — for API routes, default to unit unless coverage explicitly named the integration path).
- **File type, complexity, dependencies**: infer from the file path and the prior command's observations. If the review/coverage file didn't capture a piece of metadata you need for batching (rare), spot-`Read` only that file — not the entire target list.

This path should produce a plan with zero source-file Reads in the main context.

#### Step 2b: Fresh analysis (branch-diff, folder, or file args)

Work through each target file and extract:

1. **File type** — classify from the path and, if needed, a brief Read:
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
2. **Complexity** — score using function count (×2), Prisma/db (+10), better-auth (+8), external APIs (+8), file system (+5), side effects (×3), branching (×2). <10 simple, 10–24 medium, 25+ complex.
3. **Dependencies to mock** — Prisma, auth, logger, Next.js headers/cookies, fetch, etc.
4. **Key behaviors** — happy path, validation/error cases, edge cases, security paths.
5. **Existing test state — check BOTH unit and integration locations.** A single source file may have a unit test, an integration test, or both. Compute both candidate paths and check each with `Read` (not `Glob`):
   - **Unit**: mirror the source under `tests/unit/`. Examples: `lib/foo/bar.ts` → `tests/unit/lib/foo/bar.test.ts`; `app/api/v1/foo/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`.
   - **Integration**: under `tests/integration/`, stripping the `app/` prefix for route handlers. Examples: `app/api/v1/foo/route.ts` → `tests/integration/api/v1/foo/route.test.ts`. Non-API source files (`lib/...`, `components/...`) rarely have integration tests — skip the integration probe unless the source is under `app/`.
   - **Dynamic-route paths (`[id]`, `[slug]`, `[...params]`):** Next.js dynamic segments use square brackets. `Glob` treats `[id]` as a character class (matching `i` OR `d`), so a Glob pattern `tests/unit/app/api/v1/users/[id]/route.test.ts` silently matches nothing even when the file exists. Use `Read` for mirror-path existence checks — it takes the path literally and errors cleanly when absent, which is the signal you want. Reserve `Glob` for wildcard folder scans (`tests/unit/<folder>/**/*.test.{ts,tsx}`) where `**` traverses bracket directories correctly.
   - For each existing test file found, classify its tests as **keep**, **rewrite**, or **delete** (tests that reference functions/exports no longer present in the source, or describe behaviour the source no longer has) and note what's **missing**. Delete items represent stale tests for removed code — they go into the plan's per-file Delete count and get removed by `/test-write`.
   - When a source file has BOTH a unit and integration test, emit **two separate plan items** (one per type). Each carries its own Keep/Rewrite/Add/Delete breakdown because the two tests cover different contract layers (unit = function/handler logic under mocks; integration = request → validation → auth → handler → DB → response under real DB).
6. **Type decision when no test exists (api-route only):** if the source is an API route (`app/api/**/route.ts`) with no existing test, default to proposing a **unit** plan item. Add a second **integration** plan item when the route: (a) enforces auth via `withAuth()`/`withAdminAuth()`, (b) performs a DB mutation (POST/PATCH/DELETE), (c) touches multiple collaborators (auth + DB + email, etc.). Non-route source files default to unit only.

**Parallelization for fresh analysis:**

- **1–3 target files** — analyze inline in the main agent (subagent overhead exceeds savings).
- **4+ target files** — spawn one **Sonnet** subagent per file using `Agent` with `model: "sonnet"`. Send all calls in a single message to run them in parallel. Each subagent reads its own source + existing test file (do NOT inline contents in the prompt).

**Subagent prompt template (fresh analysis, 4+ files only):**

> You are a test planner. Analyze one source file and, if present, its existing test file(s) — checking BOTH unit and integration locations — and produce structured planning metadata.
>
> **Source file**: `{source_path}`
> **Unit test candidate**: `{unit_test_path}` — check with Read; skip gracefully if not found.
> **Integration test candidate**: `{integration_test_path}` — check with Read; skip gracefully if not found. Empty string if the source file is not under `app/` (non-routes rarely have integration tests).
>
> Read the source plus whichever test files exist. Extract the fields below and return them in the exact format specified. No preamble, no summary.
>
> Fields: file type, complexity (simple/medium/complex), dependencies to mock, key behaviors (happy path + error/edge cases), per-test-type classifications (keep/rewrite/delete/missing).
>
> Emit ONE block per test type that has an existing file OR is worth planning for (see "Type decision" rule in Step 2b: unit is always worth planning; integration is worth planning for API routes with auth/mutation/multi-collaborator behaviour). If a test type is neither existing nor worth planning, omit its block entirely.
>
> ```
> PLAN: {source_path}
> FILE_TYPE: {classification}
> COMPLEXITY: simple | medium | complex
> MOCKS: {comma-separated dependencies}
>
> BEHAVIORS:
> - {behavior — happy path, edge, error}
>
> --- UNIT ---
> TEST_FILE: {test path or "none"}
>
> KEEP:
> - {test name} L{N}
>
> REWRITE:
> - {test name} L{N} — {reason} | SHOULD: {what to assert}
>
> DELETE:
> - {test name} L{N} — {reason}
>
> MISSING:
> - {scenario} — {why}
>
> --- INTEGRATION ---
> TEST_FILE: {test path or "none"}
>
> KEEP:
> - {test name} L{N}
>
> REWRITE:
> - {test name} L{N} — {reason} | SHOULD: {what to assert}
>
> DELETE:
> - {test name} L{N} — {reason}
>
> MISSING:
> - {scenario} — {why — for integration, include contract layer: auth boundary, full envelope, DB persistence, rate limit, etc.}
> ```
>
> Omit any section (KEEP/REWRITE/DELETE/MISSING) with no entries. Omit an entire `--- UNIT ---` or `--- INTEGRATION ---` block if the type isn't applicable. Keep lines under ~200 chars.
>
> **Integration MISSING — auth-guard branch enumeration**: when the source handler has an ownership-or-admin guard (e.g. `if (session.user.id !== id && session.user.role !== 'ADMIN')`, `if (resource.ownerId !== session.user.id)`, any mixed `self === id` + `role === 'ADMIN'` check), the guard has THREE branches, not two. Enumerate each as a separate MISSING entry unless already covered:
>
> 1. Unauthenticated (401) — no session.
> 2. Wrong principal (403) — authenticated non-owner, non-admin.
> 3. **Self-access sub-path** (200 or the guard's happy result) — authenticated principal whose `session.user.id === targetId`. This is the branch that lets a USER through without the ADMIN role and is easy to miss because it's structurally asymmetric with 401/403.
>
> Also enumerate self-action guards on mutations — e.g. DELETE's "cannot delete self" (`session.user.id === id` guard at handler body, not the auth wrapper), PATCH's "cannot demote self". Each self-action guard is its own MISSING entry with expected status + error envelope shape.

After subagents return, aggregate their outputs — do not re-read the files.

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

For each plan item (one per source+type combination — a single source may produce a unit item AND an integration item), produce structured instructions that `/test-write` will pass to test-engineer agents:

```
### {source file path} — {unit | integration}
**Test file**: {path} (CREATE / UPDATE)
**Test type**: unit | integration
**File type**: {classification}
**Complexity**: simple / medium / complex
**Coverage target**: {percentage based on module type}

**Keep** (do not modify):
- `{test name}` (line {N})

**Rewrite** (fix these existing tests):
- `{test name}` (line {N}) — {reason}. Should: {what the rewritten test should assert}

**Add** (new test cases needed):
- {scenario description} — {why: error path / edge case / uncovered branch at source line N}

**Mocking requirements**:
- {dependency}: {mock strategy — for integration items, note which boundaries stay real (DB via testcontainer) vs mocked (external HTTP, email sender, LLM providers)}
```

For integration items, the **Add** section should additionally cover (when applicable): 401 unauthenticated, 403 wrong-role, 429 rate-limit exceeded, DB-state readback after mutation, full `errorResponse()` envelope on failure paths. Don't force items that don't apply — a public GET route doesn't need 401/403 coverage; note "public route, no auth coverage needed" in the item's notes.

**Auth-guard branch enumeration (integration items only):** if the source has an ownership-or-admin guard (`if (session.user.id !== id && session.user.role !== 'ADMIN')` and variants) OR a self-action guard on a mutation (`if (session.user.id === id) return errorResponse(...)`), every branch of the guard becomes its own Add item unless already covered:

- **Ownership-or-admin guards** produce three Add items: 401 (no session), 403 (authenticated non-owner, non-admin), and the **self-access sub-path** (authenticated principal whose `session.user.id === targetId` — the branch that lets a USER through without ADMIN role). The self-access branch is asymmetric with the 401/403 pair and is the one most likely to be forgotten.
- **Self-action guards on mutations** (e.g. DELETE "cannot delete self", PATCH "cannot change own role") produce one Add item each with the expected status + error envelope shape, including the `code` if one is set.

Never collapse these into "covered by unit" — the unit test exercises the handler body with a mocked session; the integration test exercises the full wrapper → guard → handler → response chain. A regression that reorders the auth-wrapper's guards or changes the session shape would only be caught integration-side.

**Self-check before writing each file's instructions:**

- **Add/Rewrite overlap** — for every Add item, check whether an adjacent Rewrite already implies it. Example: if a Rewrite now asserts `toHaveBeenCalledWith({...})`, it already proves single-fire, so a separate "called exactly once" Add is redundant. Drop the Add, or merge its intent into the Rewrite's assertion.
- **Rewrite recommendation shape** — if your "Should" line prescribes `toHaveBeenNthCalledWith` across multiple renders, split the rewrite into separate `it` blocks (one render each) before forwarding. See `.claude/docs/test-brittle-patterns.md` for the full anti-pattern list the plan and agent should steer clear of.

### Step 4.5: Source sanity check on Rewrite prescriptions (from-review mode only)

Runs only in `from-review` mode — the review's `Should:` lines are concrete assertion prescriptions that can be validated against current source. Coverage and branch-diff modes don't produce prescriptions to check.

The goal is to catch plan-level errors before the agent hits them mid-execution. A prescribed `toHaveBeenCalledTimes(2)` that's impossible given a source-level guard, or a prescribed signature that doesn't match the real call site, costs ~50k agent tokens to discover during `/test-write`. Spotting it here costs ~5k planner tokens.

For each **Rewrite** item across all files whose `Should:` line prescribes a specific call count (`toHaveBeenCalledTimes(N)`, `.not.toHaveBeenCalled()`) or a specific call signature (`toHaveBeenCalledWith({...})`):

1. Identify the source function, hook, or effect that the linked test exercises. Use the review's line references plus the test's existing assertions as context.
2. Read the narrow source range around that function/effect — just the relevant closure, not the whole file.
3. Check for structural elements that could invalidate the prescribed assertion:
   - **One-shot `useRef` guards** (e.g. `if (someRef.current) return`) that block re-runs on the same component instance. A count=2 prescription against a guarded-once effect will never pass without a fresh mount.
   - **Early returns** that skip the call path being asserted under realistic test conditions.
   - **Conditional effects / dependencies** — `useEffect(() => {...}, [dep])` where the prescribed call only fires under specific `dep` values.
   - **Async ordering** — prescribed counts that assume a synchronous path that's actually gated on a promise chain.
   - **Signature drift** — the prescribed `toHaveBeenCalledWith({...})` object shape doesn't match what the source actually passes to the mocked function.
4. If anything looks suspicious, record it in a `Sanity-check flags` list. If the prescription checks out, silently pass.

**Rules:**

- Read only the source ranges you need. One targeted `Read` per suspicious Rewrite — not a whole-file read per file.
- Each flag is a soft signal, not a block. Include it in the plan file and the terse summary so the user sees it during the usual confirmation flow.
- False positives are acceptable (user reads the note and waves it through). False negatives — missed catches — are the cost this step exists to avoid.
- Do NOT modify the `Should:` line automatically. The plan records the review's prescription plus the flag; the user chooses whether to adjust before running `/test-write`.

The flags are rendered into the plan file as a `## Sanity-Check Flags` section (see Step 6 format). `/test-write` reads them and passes them through to the test-engineer agent as "if you hit this, it's a plan error — follow the gotchas doc and revise the assertion, don't park as a source finding."

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

**Test-type batching:** never mix unit and integration items in the same batch. Integration tests use testcontainer setup and different mocking strategies; bundling them with unit items inflates mocking requirements and confuses the test-engineer. Two plan items for the same source file (a unit item + an integration item) go into separate batches — typically the unit item lands in an earlier sprint (cheaper, faster feedback) and the integration item follows.

### Step 5.5: Build the Source Decisions audit block

Consume the decisions captured during Step 1's source-finding gate. The block exists for traceability: anyone reading the plan can see which source gaps were accepted as refactors versus documented or skipped.

For each source finding with decision `fix` or `document`, record:

```markdown
### `{source path}:{line}` — {summary}

**Linked test items**: {list of finding indices, e.g. "1, 3, 4"} — `{test file}:{line}` — `{issue}`
**Decision**: Fix | Document
**Reasoning**: {short line — "refactor pre-approved for clean hook extraction" / "behaviour intentional; assert as-is"}
**If Fix**: {refactor description from the review, including any code snippet and blast radius}
**If Document**: {what the test should assert about the current behaviour + SOURCE DECISION comment text}
```

`skip` decisions don't appear here — the dependent test findings were already dropped from the work list in Step 1.

**Per-test rewrite instructions inherit the decision:**

- `Fix` → test-engineer applies the source refactor first, then rewrites the test against the fixed contract.
- `Document` → test asserts the CURRENT behaviour and includes a `// SOURCE DECISION: Document — {reason}` comment so the next reviewer sees why the apparent smell is intentional.

If no source findings were referenced, or every decision was `skip`, omit the Source Decisions block from the plan entirely.

### Step 6: Write the full plan to file

Write the complete plan to `.claude/tmp/test-plan.md`, overwriting any prior plan. This file is the authoritative record — `/test-write plan` reads from it. Follow the shared protocol in `.claude/docs/test-command-file-protocol.md` — every file must start with the metadata frontmatter block.

Before writing, capture git state with Bash:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -u +%Y-%m-%dT%H:%M:%SZ
```

The file format:

```markdown
---
command: test-plan
scope:
  {
    scope string — inherit from the prior review/coverage file if consuming one,
    else the path args,
    else "branch diff vs origin/main",
  }
mode: targeted | branch-diff | from-review | from-coverage
branch: { current branch }
head: { current HEAD SHA }
generated: { ISO 8601 UTC timestamp }
---

# Test Plan

**Source**: {what drove this plan — branch name, folder paths, or prior command + its file}
**Target files**: {count} ({source_file_count} source files · {plan_item_count} plan items across types)
**Test types**: {unit_item_count} unit · {integration_item_count} integration
**Estimated complexity**: {simple} simple, {medium} medium, {complex} complex
**Sprints**: {count}
**Source decisions**: {count} — {fix_count} Fix, {document_count} Document, skipped dependents dropped during planning
**Sanity-check flags**: {count} — Rewrite prescriptions flagged against current source (from-review mode only; 0 in other modes)

---

## Sanity-Check Flags

{Only included if Step 4.5 flagged anything — from-review mode only. Omit section entirely if 0.}

Rewrite prescriptions whose `Should:` assertion looks suspicious given the current source. Each flag is a soft signal, not a block. Review each before running `/test-write`; if the concern is real, adjust the `Should:` line in the per-file Rewrite section below. `/test-write` will pass each flag through to the test-engineer agent as "if you hit this mid-execution, it's a plan error — revise the assertion, do not park as a source finding."

### `{source path}:{line}` — `{test name}`

**Prescribed**: `{Should: line from the review / per-file Rewrite section}`
**Concern**: {one-line note — which guard / early return / conditional / signature mismatch was spotted}
**Suggested revision**: {optional — if there's an obvious fix, suggest it; otherwise say "adjust during review"}

---

{repeat per flag}

## Source Decisions (audit)

{Only included if source findings with decision `fix` or `document` were captured during Step 1. Omit entirely otherwise.}

Captured during Step 1's source-finding gate. `/test-write` reads these to pick the right rewrite strategy per linked test: Fix → apply refactor first then test against fixed contract; Document → assert current behaviour with SOURCE DECISION comment.

### `{source path}:{line}` — {summary}

**Linked test items**: {finding indices} — `{test file}:{line}` — `{issue}`
**Decision**: Fix | Document
**Reasoning**: {short rationale}
**If Fix**: {refactor description including any code snippet and blast radius from the review}
**If Document**: {what the test should assert + SOURCE DECISION comment text}

---

{repeat per source decision}

## Brittle Patterns to Avoid

Test-engineer agents must check this list before writing or rewriting any test in this plan. Authoritative source: `.claude/docs/test-brittle-patterns.md`.

**General patterns** (always include):

- **Multi-render `toHaveBeenNthCalledWith` in one `it` block** — index-dependent assertions shift on earlier failures. Split into separate `it` blocks.
- **`.not.toThrow()` on empty arrow functions** — `expect(() => {}).not.toThrow()` is tautological. Assert an observable post-error state instead.
- **Mid-test `vi.clearAllMocks()` before `not.toHaveBeenCalled()`** — wipes history; the negative assertion becomes trivially true. Use explicit counts (`toHaveBeenCalledTimes(N)`) before and after the action.
- **Dead `vi.mock(...)` blocks** — if the source no longer imports the module, delete the mock rather than annotate it. Dead mocks mislead future readers.
- **`.toBeDefined()` after `.find()`** — produces unhelpful failure messages. Assert the specific element/property, or query with a selector that throws descriptively when missing.
- **Add/Rewrite overlap in your assignment** — if an Add duplicates what a Rewrite already asserts, flag it in your final output and merge rather than writing both tests.

**Integration patterns** (include ONLY if this plan touches any file under `tests/integration/**` — omit the section entirely otherwise):

- **Status code is part of the contract** — every handler invocation gets `expect(response.status).toBe(N)`. Body shape alone is not enough.
- **Persistence asserted only via response body** — for POST/PATCH/DELETE, read the DB back (even under Prisma mock) and assert on handler-derived fields (id, createdAt, computed defaults), not echoed request fields.
- **Error envelope drift** — assert the full `{ success: false, error: { code, message } }` shape, not `body.error.code` alone or an ad-hoc `{ error: 'string' }`.
- **Missing 401/403 coverage on guarded routes** — if the route uses `withAuth`/`withAdminAuth`, write the unauthenticated AND (if role-based) wrong-role tests. Public routes are exempt; note it in a comment.
- **Module-level state not reset** — `vi.clearAllMocks()` does NOT reset rate limiter counters, in-memory caches, or singleton Prisma instances. Explicitly `.mockReturnValue()` every accessor whose default state matters in each test's arrange step.
- **Serial test dependency** — each `it()` arranges its own fixtures. No "should create X" → "should update X" chains sharing state.
- **Real `DATABASE_URL` leaking into test setup** — integration tests use the testcontainer-provided URL from `beforeAll`; never read `process.env.DATABASE_URL` directly.

---

## Sprint 1: {name}

**Files**: {count} · **Estimated agents**: {count} · **Priority**: {level}

### Batch 1.1: {description}

**Test type**: unit | integration (every item in the batch shares this type — see Step 5's test-type batching rule)

| #   | File   | Action        | Complexity            | Keep    | Rewrite | Add     | Delete  |
| --- | ------ | ------------- | --------------------- | ------- | ------- | ------- | ------- |
| 1   | `path` | CREATE/UPDATE | simple/medium/complex | {count} | {count} | {count} | {count} |

{Per-file work instructions from Step 4 for each file in this batch}

### Batch 1.2: {description}

...

---

## Sprint 2: {name}

...

---

## Mocking Requirements

{Unique dependencies across sprints with mock strategy — reference `.context/testing/mocking.md`}

## Summary

| Sprint | Type                | Files   | Agents  | Priority   | Scope   |
| ------ | ------------------- | ------- | ------- | ---------- | ------- |
| 1      | unit \| integration | {count} | {count} | {priority} | {brief} |

## Notes

{Observations affecting testing strategy — tight coupling, missing source-level validation, source changes recommended before testing, etc.}
```

### Step 7: Print terse summary to chat

Do NOT print the full plan in chat. Print a short, scannable summary only — the user can open the file for per-file detail.

Format:

```
## Test Plan — {scope}

{N} plan items ({U} unit · {I} integration) · {simple}/{medium}/{complex} simple/medium/complex · {S} sprint{s}{If source decisions: · **{D} source decision{s} carried forward ({R} resolved, {A} accepted)**}{If sanity-check flags: · **{F} sanity flag{s} — review before /test-write**}
Full plan: `.claude/tmp/test-plan.md`

{If sanity-check flags present, show BEFORE source decisions and sprint table — this is the signal the user most needs to act on:}
### Sanity-Check Flags ({F})
{Up to 3 highest-concern, one per line: `- source/path.ts:NN — {test name}: {concern summary}`}
{If >3: "(+{N} more in file — open `.claude/tmp/test-plan.md` to review)"}

{If source decisions present, show a compact audit line BEFORE the sprint table:}
### Source Decisions (audit — captured during planning)
{Up to 3 highest-impact, one per line: `- source/path.ts:NN — Fix: {refactor summary}` or `- source/path.ts:NN — Document: {reason}`}
{If >3: "(+{N} more in file)"}

| Sprint | Batch | Type | Files | Priority | Focus |
|--------|-------|------|-------|----------|-------|
| 1 | 1.1 | unit | {count} | {priority} | {brief — e.g., "Validation schemas"} |
| 1 | 1.2 | unit | {count} | {priority} | {brief} |
| 2 | 2.1 | integration | {count} | {priority} | {brief — e.g., "Auth + DB mutations"} |

### Notes
{Up to 3 bullets covering test-strategy notes — tight coupling, shared mock setup, ordering dependencies. If none, write "None — plan is self-contained."}

Next: `/test-write plan` (Sprint 1) · `/test-write plan sprint N` · `/test-write plan all`
```

Keep chat output under ~28 lines regardless of plan size. If there are >6 batches, show the first 6 and note "(+{N} more in file)".

### Step 8: Offer to execute

After the summary, ask:

> Plan ready. Which sprint would you like to execute?
>
> - `/test-write plan` — execute Sprint 1 (recommended)
> - `/test-write plan sprint 2` — execute a specific sprint
> - `/test-write plan all` — execute all sprints sequentially
>
> Or raise any of the Notes items first if a test-strategy concern needs discussion.

Do NOT write any test files — this command only produces the plan. Use `/test-write` to execute it.
