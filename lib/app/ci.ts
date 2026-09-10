/**
 * App declarations for the CI and test gates.
 *
 * **Fork-owned scaffold** — Sunrise ships both lists empty and does NOT change
 * this file after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's exports, not their values).
 *
 * Auto-wired in two places: `vitest.config.ts` spreads
 * {@link appCoverageExclusions} into `coverage.exclude`, and
 * `scripts/ci/scoped-tests.ts` spreads {@link appAlwaysRunTests} into
 * `ALWAYS_RUN_TESTS`, which `npm run test:changed` and `/pre-pr` union into
 * every scoped run.
 *
 * ## Why this exists
 *
 * Both platform lists are *core* registries with core guards over them, and
 * neither had anywhere for a fork to put its own entry. A fork that added one
 * `tsx` CLI script and one whole-tree test had to edit three Sunrise-owned
 * files it had never touched (#759) — `vitest.config.ts`,
 * `scripts/ci/missing-tests.ts` and `scripts/ci/scoped-tests.ts` — to declare
 * artefacts that were entirely its own. Each is a cheap "keep mine" on merge,
 * but it is a conflict on three files that had none, and every fork with a
 * script of its own meets it.
 *
 * Declaring here keeps the core lists — and the guards that hold them
 * accurate — exactly as they are for core entries, while your entries stay
 * yours.
 *
 * Boundary-clean: no imports at all, so this stays within the `lib/app/**`
 * framework-agnostic boundary and can be read by a vite config, a `tsx` script
 * and a test alike.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/testing/scoped-runs.md
 */

/** One path the coverage reporter should not have an opinion about. */
export interface AppCoverageExclusion {
  /**
   * The pattern, exactly as vitest's `coverage.exclude` takes it (picomatch).
   *
   * Note that `coverage.exclude` does NOT honour `!`-negated entries, so a
   * re-include has to be expressed inside the pattern — the extglob
   * `scripts/smoke/!(*-assertions).ts` upstream is the worked example.
   */
  pattern: string;
  /**
   * Why coverage cannot see it — concrete, in the terms the next person needs.
   *
   * "Structurally 0%" is not a reason on its own; *"a standalone `tsx` entry
   * point nothing imports, so vitest never executes it"* is. A required field
   * rather than a comment, so the decision travels with the entry instead of
   * living in a diff.
   */
  reason: string;
}

/**
 * Coverage exclusions this fork adds to Sunrise's own.
 *
 * The case this is for: a **standalone CLI entry point** — `main()` at module
 * scope, `process.exit()`, nothing importing it. It is absent from a full
 * coverage run altogether and only materialises at 0% when a scoped run forces
 * it in, i.e. the first time anyone edits it, where the per-file 80% floor then
 * fails on a file no test could ever have covered.
 *
 * **Extract the logic first, exclude second.** Upstream's convention is the
 * `*-assertions.ts` split: the pure logic a harness or probe extracts to be
 * testable stays gated like any other source file, and only the I/O wrapper is
 * excluded — which is why `scripts/smoke/!(*-assertions).ts` spares one and not
 * the other. An exclusion covering logic you could have tested buys silence,
 * not a gate.
 *
 * **What an entry here does NOT do.** `/pre-pr` step 4f
 * (`npm run check:missing-tests`) still asks whether an excluded file should
 * have a test, exactly as it does for every core exclusion. That check reports
 * and never gates, so the answer is given in review rather than silenced here.
 *
 * @example
 * ```ts
 * export const appCoverageExclusions: AppCoverageExclusion[] = [
 *   {
 *     pattern: 'scripts/boundary/!(*-assertions).ts',
 *     reason:
 *       '`scripts/boundary/check.ts` is a tsx CLI run by `npm run framework:boundary` ' +
 *       'in the lint job — filesystem and ESLint I/O that nothing imports. Its pure ' +
 *       'logic lives in scripts/boundary/lib.ts and is unit-tested.',
 *   },
 * ];
 * ```
 */
export const appCoverageExclusions: AppCoverageExclusion[] = [];

/** One test that must run regardless of what the module graph says. */
export interface AppAlwaysRunTest {
  /**
   * Repo-relative path, forward slashes. Must exist — a typo fails the guard.
   *
   * It does not have to live under `tests/`: a colocated `lib/framework/
   * boot-order.test.ts` is fine, as is `.spec.ts`, matching what the selection
   * side already collects. What it must be is a test file the runner can hand
   * to `vitest` as an argument.
   */
  path: string;
  /**
   * What tree state it reads, i.e. why no import chain reaches it.
   *
   * Keep it concrete: "reads the tree" is not a reason, *"reads
   * `prisma/seeds/` off disk and nothing imports a seed file"* is. The reason
   * is what tells the next person whether their new test belongs here.
   */
  reason: string;
}

/**
 * Whole-tree tests this fork adds to Sunrise's own always-run list.
 *
 * The case this is for: a test whose **subject is the repository**, not a
 * module — it globs a directory, parses a schema, greps for a call site, or
 * runs a tool over the tree. `vitest --changed` selects by import graph, and no
 * import chain reaches a test like that, so the change it exists to catch is
 * precisely the change that will not select it.
 *
 * **A scoped run is a pre-flight, not the last gate.** CI's `test-full` job runs
 * the whole suite on every PR while `CI_TEST_SCOPE` is `full` (the default), so
 * a list one entry short costs a local run that misses something CI then
 * catches. On a fork that sets `CI_TEST_SCOPE=changed` that net has a hole —
 * see `.context/testing/scoped-runs.md`.
 *
 * @example
 * ```ts
 * export const appAlwaysRunTests: AppAlwaysRunTest[] = [
 *   {
 *     path: 'tests/unit/prisma/seeds/framework-boot-order.test.ts',
 *     reason:
 *       'reads `prisma/seeds/` off disk to hold `_framework/` sorting after the core ' +
 *       'seeds and before any leaf directory. Nothing imports a seed file, and a rename ' +
 *       'errors nowhere — a leaf seed just stops finding its rows.',
 *   },
 * ];
 * ```
 */
export const appAlwaysRunTests: AppAlwaysRunTest[] = [];
