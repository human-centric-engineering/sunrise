# Lint Toolchain

How ESLint and its plugins are pinned and configured, and why. This exists so
forks and teammates understand the deliberate version holds and the incremental
React Compiler adoption rather than treating them as drift.

Config lives in `eslint.config.mjs` (flat config). Pins live in `package.json`
devDependencies; coordination holds live as `ignore` rules in
`.github/dependabot.yml`.

## Two independent problems (do not conflate)

Lint-toolchain upgrades split into two tracks with different fixes. **The tell:**
a package that _crashes_ ESLint is an engine incompatibility (Track 2); a package
that _runs and reports new lint errors_ is a stricter ruleset on a working engine
(Track 1).

### Track 1 — stricter rules on ESLint 9 (adopted)

ESLint stays on the 9.x line, which all our plugins run on cleanly. Two rule-set
adoptions have landed here:

- **`typescript-eslint` 8.60** — added `no-unnecessary-type-assertion` (auto-fix
  swept ~1100 redundant `as`/`!` across the tree). See the Json-write idiom note
  in `.context/database/models.md` for the one case the rule false-positives on.
- **`eslint-plugin-react-hooks` 7.1** — bundles the **React Compiler** ruleset.
  Adopted incrementally; see below.

### Track 2 — the ESLint 10 engine jump (upstream-gated, NOT adopted)

ESLint and `@eslint/js` are held below 10. `eslint-plugin-react@7.37.5` **crashes**
under ESLint 10 (`contextOrFilename.getFilename is not a function`). This is an
engine incompatibility, not a decision to stay behind: remove the hold once the
React ESLint plugins (`eslint-plugin-react`, re-check `eslint-config-next`,
`@next/eslint-plugin-next`, `eslint-plugin-jsx-a11y`) support ESLint 10, then bump,
mop up any rule-default changes, and unpin.

ESLint 9 + the Track 1 rulesets adopted is a clean, current baseline — Track 2 is
not a blocker for that.

## React Compiler ruleset — correctness on, optimization-advisories off

`eslint-plugin-react-hooks` 7.1's `recommended` preset turns the **full React
Compiler ruleset on as errors**. The decisive fact for how we configure it:
**Sunrise does not run the React Compiler** — there is no `babel-plugin-react-compiler`
and no `reactCompiler` flag in `next.config`. That splits the ruleset cleanly:

- **Correctness rules** catch real bugs whether or not the compiler runs. Kept at
  `error`, all fixed to zero.
- **Optimization-only advisories** flag code the compiler can't auto-memoize. With
  no compiler running, they warn about an optimization we don't use — pure noise.
  Turned **off** (not deferred-as-warn — off, so they don't accumulate as ignored
  warnings).

### Correctness rules — `error`, fixed to zero

- `rules-of-hooks` — conditional/looped hook calls. Load-bearing; never relax.
- `refs` — reading/writing a ref during render (breaks concurrent rendering /
  StrictMode regardless of the compiler). Fix: sync the ref in an effect, or
  promote to state if render output depends on it. (This caught a real bug — see
  `attachment-picker-button`, whose busy spinner read a ref and so never rendered.)
- `purity` — impure calls during render (`Date.now()`, `Math.random()`, mutation).
  Fix: derive from state updated in an effect/event, or a `useMemo`.
- `error-boundaries` — JSX constructed inside `try/catch` (a real misconception:
  render errors aren't caught there). Fix: wrap only the throwing op; return JSX
  outside the `try`.
- `set-state-in-render` — setState during render → infinite loop. A genuine bug;
  **stays at `error`** (this is the rule that matters, not `set-state-in-effect`).
- `preserve-manual-memoization` — kept at `error`; the few hits were optional-member
  deps (`obj?.field`) extracted to plain locals, which is a readability win anyway.
- `immutability`, `globals`, `gating`, `static-components`, `use-memo`, `config` —
  preset defaults; zero violations.
- `exhaustive-deps` (preset `warn`) — real stale-closure bugs, compiler-independent,
  low false-positive rate. **Stays on at `warn`.** The handful of existing warnings
  were triaged and fixed (add the missing dep / `useMemo` an unstable derived dep /
  drop a redundant one), so it currently sits at zero.

### Optimization-only advisories — `off`

- **`set-state-in-effect`** (was error; **off**) — "calling setState synchronously
  within an effect can trigger cascading renders." We triaged all 51 sites: every
  one is an intentional pattern a non-Suspense, client-fetch app cannot avoid —
  fetch-on-mount (`setLoading(true)` then `await`), dialog reset-on-open,
  hydrate-from-`localStorage`. Zero are bugs. Against this architecture the rule is
  ~100% false-positive, and the "fix" would be migrating data fetching to Suspense /
  a data library — a separate, large effort. The genuine bug it's adjacent to
  (render-phase setState loops) is caught by `set-state-in-render`, which stays on.
- **`incompatible-library`** (preset `warn`; **off**) — React Hook Form's
  `useForm().watch()` returns a value the compiler can't memoize (~16 form
  components). _Purely_ a compiler-optimization signal; with no compiler it is
  irrelevant. If the compiler is ever enabled, re-enable this and migrate
  `watch('field')` → `useWatch({ control, name: 'field' })`.

**If you enable the React Compiler later:** turn `set-state-in-effect` and
`incompatible-library` back on, then work through them — at that point the
diagnostics become actionable (they gate real auto-memoization).

### Scoped off for tests

The remaining render-purity correctness rules (`globals`, `purity`, `immutability`,
`refs`, `preserve-manual-memoization`) and `exhaustive-deps` are **off** for test
files. Test components intentionally do things a shipped component never would —
assigning render output to an outer variable to assert on it, mutating shared
fixtures. `rules-of-hooks` stays on for tests — conditional hook calls are a real
bug there too.

## TypeScript return types — module boundaries only

We enforce explicit return/argument types at **module boundaries** (exported
functions) via `@typescript-eslint/explicit-module-boundary-types` at `error` —
NOT `explicit-function-return-type` (which also flags every file-local helper).

Rationale: an exported function's signature is a cross-module contract, where an
inferred return type silently drifting is a real maintenance hazard. A file-local
helper's return type is not a contract — annotating it is the same ceremony we
avoid on component returns. So:

- **`.ts`**: `explicit-module-boundary-types` at `error` — exported functions need
  explicit return (and argument) types; internal helpers stay inferred.
- **`.tsx`**: rule `off` — exported React components return `JSX.Element` /
  `Promise<…>` (async Server Components); the ecosystem infers this reliably and
  hand-annotating it is error-prone.
- **tests**: `off`.

This replaced a blanket `explicit-function-return-type` that produced ~540 warnings
(514 on `.tsx` components — pure ceremony). The switch also surfaced exported API
surfaces the blanket rule had missed (e.g. the `apiClient` methods in
`lib/api/client.ts`), which now carry explicit return types.

## App boundary — `lib/app/**`

`lib/app/**` is the supported surface where forks/apps add their own platform-level
code. Its inhabitants are the **auto-wired bootstrap files** — `lib/app/env.ts`
(env schema), `lib/app/rate-limit.ts`, `lib/app/capabilities.ts`,
`lib/app/admin-nav.ts`, `lib/app/protected-routes.ts` (extra authed route
prefixes, read by the proxy) — each imported by the core consumer that runs in
the matching Next.js bundle realm (server / middleware / client). A dedicated
flat-config override keeps that surface **framework-agnostic** so it survives Next.js
upgrades and can be reasoned about in isolation:

- **No RUNTIME `next/*` imports** (including the `next/dist/**` deep-import escape
  hatch). `import { NextResponse } from 'next/server'` is an error. **Type-only
  imports are allowed** (`import type { NextRequest } from 'next/server'`) — they
  erase at compile time and don't couple runtime code to the framework. This is
  the one place we use `@typescript-eslint/no-restricted-imports` (not the base rule)
  specifically for its `allowTypeImports` support.
- **No `react-dom` / `react-dom/*` imports.** `ReactDOMServer.renderToString` and
  hydration entry points are framework glue that belongs in `app/`, not the portable
  extension surface — and they land in the client bundle on hydration if mis-imported.
- **No Prisma imports** (`prisma`, `@prisma/*`). The portable core stays
  storage-agnostic; DB access flows through `app/` route handlers or `lib/` services.
  Type-only imports of `@prisma/*` are allowed (they're needed for entity types and
  erase at compile time).
- **No Node-only built-ins** (`fs`, `fs/*`, `path`, or any `node:*` specifier). These
  crash in the edge and client realms a fork's `lib/app/` file may be bundled into.
  IO belongs in a server-only module.
- **The `@/`-alias relative-import ban is RESTATED here.** Flat-config
  `no-restricted-imports` _replaces_ rather than merges across config objects, so the
  `lib/app/**` block must re-declare the `./*` / `../*` ban or it would silently drop
  alias enforcement for these files. The base `no-restricted-imports` is turned `off`
  for `lib/app/**` so the two variants don't double-report relative imports.

**Escape hatch.** Framework glue that genuinely needs runtime `next/*` APIs belongs in
`app/` (route handlers, server actions) or a `lib/app/<name>/server/` module — not in
the portable core of `lib/app/**`. There is intentionally no `lib/orchestration`-style
boundary here; `lib/orchestration` imports `next/server` in several files and is out of
scope for this rule.

The rule's behaviour (runtime-`next` rejected, type-only allowed, relative imports
rejected, `@/` allowed) is locked by `tests/unit/eslint-app-boundary.test.ts`, which
runs the shipped rule from `eslint.config.mjs` through ESLint's `Linter`.

### Fork-owned config seam — `lib/app/eslint.config.mjs`

The boundary above is Sunrise's own. A **fork** that needs to add its _own_
import-boundary rules (e.g. a framework tier enforcing `framework ↔ core`) does
so without editing the root config: the root `eslint.config.mjs` imports and
spreads the reserved `lib/app/eslint.config.mjs` (ships `export default []`) as
its **last** argument, so fork blocks land after every core block and win for
their own `files`. Forks edit the reserved file; the platform config stays
conflict-free on `git merge vX.Y.Z`.

Two rules of the seam, both consequences of flat-config semantics already
described above:

- **Spread order is load-bearing — the seam lands last.** A later block overrides
  an earlier one for overlapping `files`. A framework-tier fork (Sunrise →
  framework → leaf) spreads its `lib/framework/eslint.config.mjs` first and keeps
  the leaf seam last.
- **`no-restricted-imports` replaces, it does not merge** (same footgun the
  `lib/app/**` block works around above). A fork block restricting imports for a
  glob must **restate the base `@/`-alias ban** for that glob, or relative-import
  enforcement silently drops there. The worked example lives in the header of
  `lib/app/eslint.config.mjs`.

The companion **CI seam** is a `package.json` addition, not a config file: the
`lint` job runs `npm run app:ci-checks --if-present`, so a fork adds an
`app:ci-checks` script (a boundary check, migration-hygiene lint, etc.) with **no
`ci.yml` edit**. It no-ops in vanilla Sunrise, which ships no such script.

## Memory: why `lint` runs under an explicit heap cap

`npm run lint` goes through `scripts/run-capped.mjs` rather than calling
`eslint` directly. Type-aware linting is by a wide margin the most
memory-hungry job in the repo, and Node's default heap is not sized for it.

**Node picks its default from machine RAM and then stops there** — 4288MB on a
16GB host, no matter how much of the other 12GB is free. Cold, whole-repo,
type-aware `eslint .` measured **18 Aug 2026**:

| Repo                  | TS files | Prisma models | Cold lint peak | Minimum viable cap |
| --------------------- | -------- | ------------- | -------------- | ------------------ |
| Sunrise 0.9.0         | 2,260    | 61            | 4.05 GiB       | fits 4288, by ~2%  |
| HCE Hub               | 2,653    | 75            | exit 134       | 5120               |
| Daybreak              | 2,777    | 80            | exit 134       | 5120               |
| ConQuest (~1.9x base) | 4,200    | 115           | exit 134       | 6144               |

Base Sunrise clears the default by about 2%; every fork with real code on top
does not. The failure is **exit 134** — SIGABRT, no message naming memory, no
stack pointing at it. Bisected on HCE Hub, the commit that flipped it was the
Sunrise 0.9.0 sync: 2,602 files passed, 2,652 aborted. Fifty files was the whole
remaining margin.

**Why it surfaces all at once.** The peak is only paid on a cold ESLint cache —
warm, the same command needs 0.41 GiB and 2.3s versus 4.17 GiB and 93s. ESLint
invalidates its entire cache when a plugin version changes, so a dependency bump
makes the next run cold for every file, and an aborted run never writes a cache
to warm the one after it.

**The cap must never override an explicit one.** A command-line
`--max-old-space-size` beats one in `NODE_OPTIONS` in both directions, so
setting the flag directly would replace whatever a fork measured and set as
`CI_NODE_HEAP_MB` with Sunrise's number, in every CI job, silently. The wrapper
appends to `NODE_OPTIONS` and only when no cap is present; in CI the workflow's
value always wins. `NODE_HEAP_MB` overrides the local default (6144), which is
itself clamped to 75% of physical memory and floored at Node's own default — a
cap above available RAM trades a clean V8 abort for an OS OOM kill.

**What is deliberately _not_ capped**, because a cap without a measurement is
the mistake this section exists to prevent:

- `type-check` — `tsc --noEmit` peaks at 1.64-1.75 GiB across Sunrise, Hub and
  Daybreak. A 2.4x margin.
- `lint-staged` (the pre-commit hook) — one staged file measured 1.85 GiB. The
  project service builds only what the linted files reach transitively, so a
  commit-sized changeset stays far below a whole-repo run.

Both are one line away in `BINS` if a fork ever measures otherwise. Re-derive by
bisection rather than guessing: raise `--max-old-space-size` until the job stops
aborting, then stop.

**If a fork outgrows even this**, the lever that works is shrinking the
TypeScript _program_, not the file list. Splitting the lint into `src` and
`tests` invocations does nothing — `tsconfig.json` includes `**/*.ts`, so the
project service builds the same whole-repo program whichever files you pass
(Sunrise src-only, 1,188 files, measured _higher_ than all 2,262). A
`tsconfig.lint.json` that excludes `tests/**`, with `project:` in place of
`projectService: true`, took ConQuest from 5.61 GiB / 209s to 4.30 GiB / 81s.
The cost is that test files lose the type-aware rules they still have —
including `no-floating-promises`, so price it before taking it.

## Backlog (post-fork-readiness, not blockers)

- **Enabling the React Compiler** — if/when adopted, re-enable `set-state-in-effect`
  and `incompatible-library` and work through their diagnostics (they become
  actionable once the compiler runs). Not planned.
- **Track 2 / ESLint 10** — unpin once the React plugins support it (above).
