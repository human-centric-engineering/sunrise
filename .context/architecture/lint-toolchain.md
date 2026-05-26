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

## Backlog (post-fork-readiness, not blockers)

- **Enabling the React Compiler** — if/when adopted, re-enable `set-state-in-effect`
  and `incompatible-library` and work through their diagnostics (they become
  actionable once the compiler runs). Not planned.
- **Track 2 / ESLint 10** — unpin once the React plugins support it (above).
