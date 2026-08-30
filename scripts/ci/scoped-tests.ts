/**
 * Scoped test runs — the pure half.
 *
 * `vitest --changed <ref>` selects test files by **module graph**: a test runs
 * if the changed file is somewhere in its import chain. That is the right
 * selector for almost every test in this repo, and it is what makes a local
 * pre-flight cheap — measured at `8167a36f`, a single-file edit selects between
 * 107 and 642 of 1081 test files depending on how central the file is.
 *
 * It is the wrong selector for one kind of test: the ones whose subject is the
 * **repository itself**. `tests/unit/lib/privacy/export-sources.test.ts` reads
 * `prisma/schema/*.prisma` off disk and fails until every model with a user FK
 * is listed in the export manifest. Nothing imports the schema, so no module
 * graph connects them, so `--changed` will never select that test no matter
 * which model you add. Same for the reserved-namespace rule, the fork-init
 * seam roster, and the outbound-redirect roster. Those are exactly the checks
 * this repo leans on hardest, and a scoped run that silently stopped running
 * them would be the "skipped gate reads as green" shape
 * `.context/architecture/ci.md` spends a section on.
 *
 * So a scoped run is `(what --changed selected) ∪ ALWAYS_RUN_TESTS`.
 *
 * WHY THE LIST IS WRITTEN AND NOT DERIVED
 * The obvious move is to detect these — scan for `readFileSync`, for a
 * `node:fs` import, for a read rooted at `process.cwd()`. All three were tried
 * against this tree and all three are incomplete, in different places. Counts
 * are as measured at `8167a36f`; they move as tests are added, and it is the
 * misses that carry the argument, not the totals:
 *
 *   - by fs-API name:     22 files, missing 3 that import fs under an alias
 *   - by fs import:       16 files, missing 9 that mock `node:fs` or go via a
 *                         helper
 *   - by repo-rooted read: 14 files, and it still cannot see
 *                         `tests/unit/eslint-app-boundary.test.ts`, which
 *                         reads the tree through ESLint's own file resolution
 *                         and imports no filesystem module at all
 *
 * That last one is the point. It is a genuine member of this list that no
 * static detector proposed, and it is why {@link undeclaredRepoRootedTests}
 * below is advisory: it prompts you to consider a file, it does not certify
 * that the list is complete. Deriving a roster that must not miss anything,
 * from a signal that demonstrably misses things, is how a check ends up
 * unable to fail.
 *
 * The safety net is that this is a **pre-flight, not the last gate**. CI's
 * `test-full` job runs the whole suite, 4-way sharded, on every PR and every
 * push to `main` — while `CI_TEST_SCOPE` is `full`, which is the default. A
 * list that is one entry short costs a local run that misses something CI then
 * catches; it does not ship the miss.
 *
 * On a fork that sets `CI_TEST_SCOPE=changed` the net has a hole: `test-full`
 * is skipped on PRs, and the `test-changed` job that replaces it runs a bare
 * `vitest --changed` with no always-run union, so the whole suite lands only
 * after merge. `.context/testing/scoped-runs.md` carries the one-line workflow
 * change that closes it.
 *
 * @see scripts/ci/run-scoped-tests.ts — the CLI that reads git and spawns vitest
 * @see .context/testing/scoped-runs.md — the operator-facing version of this
 */

/** One test that must run regardless of what the module graph says. */
export interface AlwaysRunEntry {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** What tree state it reads, i.e. why no import chain reaches it. */
  reason: string;
}

/**
 * Tests whose subject is the repository, not a module.
 *
 * Every entry was checked by reading the file, not by pattern-matching it. Keep
 * the reason concrete — "reads the tree" is not a reason, "reads
 * `prisma/schema/*.prisma`" is — because the reason is what tells the next
 * person whether their new test belongs here.
 *
 * A fork adding its own whole-tree invariant appends to this list. Nothing
 * upstream removes entries, so the merge is additive.
 */
export const ALWAYS_RUN_TESTS: readonly AlwaysRunEntry[] = [
  {
    path: 'tests/unit/lib/privacy/export-sources.test.ts',
    reason:
      'parses `prisma/schema/*.prisma` and fails until every model with a ' +
      'user FK appears in `SUBJECT_DATA_SOURCES`. Adding a model is exactly ' +
      'the change no import chain connects to this test.',
  },
  {
    path: 'tests/unit/prisma/auth-schema-parity.test.ts',
    reason:
      'reads `prisma/schema/auth.prisma` off disk and compares it against ' +
      "better-auth's own `getAuthTables()`. Its real input is the installed " +
      'better-auth version, so the change that must trigger it is a bump in ' +
      '`package.json` — which reaches no test through the module graph. That ' +
      'is how 0.11.0 shipped a 1.7 upgrade without `Account.issuer` and broke ' +
      'every sign-in.',
  },
  {
    path: 'tests/unit/app/layout-metadata.test.ts',
    reason:
      'walks `app/` off disk to derive the route modules it checks for a leaked ' +
      'brand, so its input is the presence of files. Adding a page with hardcoded ' +
      'metadata is exactly the change no import chain connects to this test.',
  },
  {
    path: 'tests/unit/reserved-fork-tiers.test.ts',
    reason:
      'walks `lib/`, `components/`, `.context/` and `prisma/schema/` to hold ' +
      'the `/app` and `/framework` namespaces empty upstream. Its input is ' +
      'the presence of files, which no module imports.',
  },
  {
    path: 'tests/unit/fork-init-seams.test.ts',
    reason: 'reads `lib/app/*` off disk to derive the seam roster and check each one is wired.',
  },
  {
    path: 'tests/unit/fork-seam-coupling.test.ts',
    reason: 'reads `lib/app/*` off disk to assert no seam imports another.',
  },
  {
    path: 'tests/unit/lib/app/defaults.test.ts',
    reason:
      'reads `lib/app/*` off disk to check every seam still ships its ' +
      'documented empty default. A new seam file changes the answer.',
  },
  {
    path: 'tests/unit/lib/security/outbound-fetch-redirects.test.ts',
    reason:
      'globs `lib/**` for outbound-fetch call sites and checks each one ' +
      'against the redirect roster. A new call site anywhere changes the ' +
      'answer — this is the #635 guard, and the roster it protects was itself ' +
      'miscounted once.',
  },
  {
    path: 'tests/unit/lib/orchestration/llm/structured-completion-no-persistence.test.ts',
    reason: 'reads the LLM source files to assert none of them persists a structured completion.',
  },
  {
    path: 'tests/unit/prisma/seeds/provider-models.capabilities.test.ts',
    reason: 'reads `prisma/seeds/009-provider-models.ts` as text to check every row declares caps.',
  },
  {
    path: 'tests/unit/types/orchestration-patterns.test.ts',
    reason:
      'reads `prisma/seeds/data/**` fixtures and cross-checks them against ' +
      'the step registry. A seed-data edit changes the answer.',
  },
  {
    path: 'tests/unit/app/route-module-distinctness.test.ts',
    reason:
      'globs `app/**` for page/layout/route modules and fails if two are ' +
      'byte-identical. Its input is the set of files on disk; the clobber it ' +
      'exists for (a landing page overwritten with the about page) is exactly ' +
      'the change no import chain connects to a test.',
  },
  {
    path: 'tests/unit/eslint-app-boundary.test.ts',
    reason:
      'runs ESLint over the tree, so its input is every source file. It ' +
      'imports no filesystem module — no static detector proposed this ' +
      'entry, which is why the list is written rather than derived.',
  },
  {
    path: 'tests/unit/vitest-environment-directives.test.ts',
    reason:
      'reads every test file to check its environment directive is a single ' +
      'value on line 1. Vitest matches that directive anywhere in a file, so a ' +
      'comment merely discussing it silently moves the file to another ' +
      'environment — and the node-to-happy-dom direction still passes. The ' +
      'input is the whole test tree, which nothing imports.',
  },
  {
    path: 'tests/unit/scripts/ci/scoped-tests.test.ts',
    reason:
      'checks every path in this list still exists on disk. Renaming or ' +
      'deleting a test elsewhere is the change that breaks it, and no import ' +
      'chain connects the two — so the guard on the list needs the same ' +
      'treatment as the things it guards.',
  },
  {
    path: 'tests/unit/lib/orchestration/llm/cost-log-fk-attribution.test.ts',
    reason:
      'walks the tree for every `logCost` call site and compares what each ' +
      "one writes into `AiCostLog`'s foreign keys against a written " +
      'allowlist. The change it exists to catch is a NEW call site — three ' +
      'of those have now written a value that is not a row id (#599, #600, ' +
      '#654), and a fourth would be in a file no import chain connects here.',
  },
  {
    path: 'tests/unit/sunrise-version-disclosure.test.ts',
    reason:
      'walks `app/` and `lib/` for every route whose import graph reaches ' +
      '`SUNRISE_VERSION`, and fails if one of them is unauthenticated. The ' +
      'change it exists to catch is a NEW route returning the platform ' +
      'version — a file that by definition no existing import chain reaches.',
  },
  {
    path: 'tests/unit/toolchain-cache-location.test.ts',
    reason:
      'reads `package.json`, `.lintstagedrc.json`, `.gitignore` and ' +
      '`.github/workflows/ci.yml` as text to hold the eslint/prettier caches ' +
      'at the repo root and keep the CI cache paths equal to what those ' +
      'scripts write. Its whole input is config files no module imports — a ' +
      'workflow-only edit is precisely the change that must trigger it (#677). ' +
      "FORK NOTE: half its subject is upstream's `.github/workflows/ci.yml`. " +
      'A fork that owns that file — renaming the lint-cache step, or folding ' +
      'lint into a workflow of its own — should delete this entry and keep its ' +
      'own version of the guard, rather than carry a red suite about a file it ' +
      'no longer shares.',
  },
];

/** Just the paths, for argv building and set arithmetic. */
export function alwaysRunPaths(): string[] {
  return ALWAYS_RUN_TESTS.map((entry) => entry.path);
}

/**
 * Test files that read from the repo root, minus the ones already declared.
 *
 * ADVISORY. It looks for a read rooted at `process.cwd()` or at a `__dirname`
 * path that climbs out of `tests/` — the two ways a test in this repo reaches
 * the source tree — and subtracts {@link ALWAYS_RUN_TESTS}. What comes back is
 * a prompt: *this file reads the tree, should it always run?* Some legitimately
 * should not, because they root a temp fixture at `cwd` and read only what they
 * just wrote.
 *
 * It cannot see a test that reaches the tree through a library (ESLint, a
 * bundler, a glob helper), and there is at least one of those on the list
 * above. Treat a clean result as "nothing new matched these two patterns",
 * never as "the list is complete".
 *
 * It also matches the patterns wherever they appear, including inside a string
 * literal — so a test whose *fixtures* are snippets of tree-reading code
 * reports itself. `tests/unit/scripts/ci/run-scoped-tests.test.ts` does exactly
 * that. Left alone rather than taught about string literals: a false positive
 * costs a glance, and every rule added here to suppress one is a rule that can
 * also suppress a real match.
 */
export function undeclaredRepoRootedTests(
  testFiles: readonly string[],
  read: (path: string) => string | null
): string[] {
  const declared = new Set(alwaysRunPaths());
  const found: string[] = [];
  for (const path of testFiles) {
    if (declared.has(path)) continue;
    const source = read(path);
    if (source === null) continue;
    if (readsRepoRoot(source)) found.push(path);
  }
  return found.sort();
}

/** `process.cwd()`, or a `__dirname`/`import.meta.dirname` path with a `../` in it. */
function readsRepoRoot(source: string): boolean {
  if (/process\.cwd\(\)/.test(source)) return true;
  return /(?:__dirname|import\.meta\.dirname)[^)\n]*\.\.\//.test(source);
}

/**
 * Paths that cannot be handed to a child process, or trusted, as they stand.
 *
 * Three shapes, all of which arrive from a tool's stdout rather than from a
 * person, and all of which this runner must refuse rather than quietly skip:
 *
 * - **A leading `-`.** Selected test files become *positional* argv for
 *   `vitest run`, and vitest's argument parser reads options wherever they
 *   appear — position does not protect them. A file whose name contains a
 *   newline is printed by `vitest list` across two lines, so the second
 *   fragment can arrive here as its own token; a fragment reading
 *   `--config=x.test.ts` would replace the whole vitest config for the run,
 *   including `setupFiles` and the coverage `exclude` list. A trailing `--`
 *   is not the fix: vitest routes post-`--` arguments to a separate bucket,
 *   not to the file filters.
 * - **A leading `"`.** git C-quotes any path containing a control character
 *   even under `core.quotePath=false`, so such a path arrives quoted and stops
 *   ending in `.ts`. It would then fall out of {@link coverageTargets}'s
 *   extension filter in silence — a changed source file dropping out of the
 *   coverage gate with nothing said, which is the failure this whole runner is
 *   written against.
 * - **A raw control character**, for the same reason from any other source.
 *
 * `scripts/ci/check-missing-tests.ts` already treats the quoted-path case as
 * "could not look" and exits 1 rather than scanning a short list. Same contract
 * here, for the same reason: there is no honest summary to print beside a file
 * you silently declined to handle.
 */
export function unsafeArgvPaths(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => path.startsWith('-') || path.startsWith('"') || hasControlCharacter(path)
  );
}

/**
 * Scanned by code point rather than matched by regex.
 *
 * A `/[\u0000-\u001f\u007f]/` literal is the obvious spelling and ESLint's
 * `no-control-regex` rejects it — correctly, since a control character in a
 * pattern is usually a typo. Here it is the whole point, so the choice is a
 * disable comment or a loop; the loop needs no exemption and says plainly what
 * it looks for.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Changed paths worth asking for coverage on.
 *
 * Deliberately thin: JavaScript and TypeScript sources, minus tests and type
 * declarations. Everything else — layouts, `lib/env.ts`, `types/**`,
 * `emails/**` — is left to `vitest.config.ts`'s own `coverage.exclude`, which
 * still applies over a CLI `--coverage.include` (verified against vitest
 * 4.1.10). One source of truth for what coverage ignores, so this cannot drift
 * away from the config the way a second copied exclusion list would.
 *
 * **`.mjs` counts, and used not to.** This filter read `.ts`/`.tsx` only, so
 * every `.mjs` in the tree bypassed the per-file floor #647 added — silently,
 * which is the failure mode this whole runner is written against. It is not a
 * hypothetical corner: `scripts/ci/**` is deliberately NOT excluded from
 * coverage, and `scripts/run-capped.mjs`, `scripts/dev-server.mjs` and
 * `scripts/ci/chunked-lint.mjs` are ordinary unit-tested tooling that the gate
 * simply could not see. The fork that found it measured a new `.mjs` at 78.66%
 * lines with `/pre-pr` reporting PASS.
 *
 * The extension list is the one `vitest.config.ts` already instruments (the v8
 * provider handles `.mjs`/`.cjs` exactly like `.ts`), so widening it here needed
 * two matching `coverage.exclude` entries there — `lib/app/eslint.config.mjs`
 * and `scripts/spikes/**`, both structurally 0% and neither production code.
 * The fork-owned config seam is the load-bearing one: without its exclusion a
 * fork editing its own `lib/app/eslint.config.mjs` would fail a coverage gate
 * on a file Sunrise ships as `export default []`.
 *
 * Note the asymmetry with `scripts/ci/missing-tests.ts`, which keeps its own
 * exemption list on purpose: that check asks "should a human have written a
 * test for this?", a question the coverage config is the wrong authority for.
 * This one asks "will the coverage reporter have an opinion?", and there the
 * config is the only authority.
 */
export function coverageTargets(changed: readonly string[]): string[] {
  return (
    changed
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      // `.d.mts` / `.d.cts` too, not just `.d.ts`. The extension filter above
      // now admits `.mts`/`.cts`, and `vitest.config.ts` excludes only
      // `**/*.d.ts` — so a fork's `lib/foo.d.mts` would reach
      // `--coverage.include` under `perFile` and fail the 80% floor on a file
      // with no executable code in it at all.
      .filter((path) => !/\.d\.[cm]?ts$/.test(path))
      .filter((path) => !path.startsWith('tests/'))
      // Colocated tests too, not just the `tests/` tree. The selection side was
      // deliberately widened to accept a fork's `.spec.ts` files, so this side
      // has to agree about where tests live — otherwise a fork that colocates
      // (`lib/foo.test.ts`) gets its own changed test files pushed into
      // `--coverage.include` and held to the 80% floor. `vitest.config.ts`'s
      // `coverage.exclude` lists `tests/` only, so it does not cover this either.
      .filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
      .sort()
  );
}

/** Everything {@link buildVitestArgv} needs. Kept flat so the CLI stays thin. */
export interface ScopedRunPlan {
  /** Test files `vitest list --changed` selected. */
  selected: readonly string[];
  /** {@link ALWAYS_RUN_TESTS}, filtered to those that exist in this tree. */
  alwaysRun: readonly string[];
  /** Changed source files to gate coverage on; empty means "no coverage". */
  coverage: readonly string[];
  /** Per-file coverage floor, matching `vitest.config.ts`'s global thresholds. */
  threshold: number;
}

/**
 * The argv for the one `vitest run` a scoped run performs.
 *
 * Files are passed positionally rather than as `--changed`, because vitest
 * **intersects** positional filters with `--changed` and this needs their
 * union: an always-run test is by definition one `--changed` did not select,
 * so asking vitest for both in a single invocation returns none of them.
 * The CLI resolves the changed set with `vitest list` first and hands the
 * union here.
 *
 * Coverage is scoped the same way the run is: `--coverage.include` limited to
 * the changed sources, and `thresholds.perFile` so the 80% floor lands on each
 * changed file individually. Without `perFile` the floor is an average across
 * the included set, which one well-covered file can carry for a bare one — the
 * opposite of what a per-PR gate is for.
 */
export function buildVitestArgv(plan: ScopedRunPlan): string[] {
  const files = [...new Set([...plan.selected, ...plan.alwaysRun])].sort();
  const argv = ['run', ...files];

  if (plan.coverage.length > 0) {
    argv.push('--coverage');
    for (const path of plan.coverage) argv.push(`--coverage.include=${escapeGlob(path)}`);
    argv.push('--coverage.thresholds.perFile=true');
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      argv.push(`--coverage.thresholds.${metric}=${plan.threshold}`);
    }
  }

  return argv;
}

/**
 * Escapes a literal path for use where a **glob** is expected.
 *
 * `coverage.include` is matched with picomatch, and Next's own routing
 * conventions are glob syntax: `app/(protected)/…` reads as an extglob
 * alternation and `app/api/auth/[...all]/…` as a character class. Neither
 * matches the file it names, so the file is not instrumented, the coverage
 * table comes back empty, and `thresholds.perFile` has nothing to fail on —
 * **exit 0**. Measured on this tree: `--coverage.include='app/(protected)/
 * dashboard/page.tsx'` reports `Unknown%` and passes, while the same path with
 * the parentheses escaped reports 0% and fails all four thresholds.
 *
 * That is the quiet green this whole runner is written against, and it would
 * have hit the most common file shape in `app/` — every route group, every
 * dynamic segment. Found by `/code-review`; worth stating plainly because the
 * bug was invisible in exactly the way the design section above warns about.
 *
 * Escaping rather than switching to a literal-path option because
 * `coverage.include` has no literal mode; picomatch honours a backslash escape
 * for each of these metacharacters.
 */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?()[\]{}!+@|^$]/g, (character) => `\\${character}`);
}

/**
 * Checks the shape of an always-run list. Exported so its own failure paths are
 * reachable from a test with a deliberately broken list — the alternative is a
 * validator whose every rejection branch is dead code that nobody has run.
 */
export function validateAlwaysRun(entries: readonly AlwaysRunEntry[]): string | null {
  if (entries.length === 0) {
    return 'ALWAYS_RUN_TESTS is empty — a scoped run would skip every whole-tree invariant.';
  }
  for (const entry of entries) {
    if (!entry.path.startsWith('tests/') || !entry.path.endsWith('.test.ts')) {
      return `ALWAYS_RUN_TESTS holds "${entry.path}", which is not a test path.`;
    }
    if (entry.reason.trim() === '') {
      return `ALWAYS_RUN_TESTS entry "${entry.path}" has no reason.`;
    }
  }
  return null;
}

/** The three collaborators {@link selfTestFailure} exercises, injectable for its own test. */
export interface SelfTestDeps {
  entries: readonly AlwaysRunEntry[];
  detect: typeof undeclaredRepoRootedTests;
  targets: typeof coverageTargets;
  build: typeof buildVitestArgv;
}

/**
 * Proves this module can still produce a non-empty answer, before any caller
 * reads a clean one from it.
 *
 * The failure this guards against is not hypothetical: #641 was a scanner that
 * printed nothing and was nearly banked as a clean tree. Here the equivalent is
 * a regex that stops matching after a refactor, so `undeclaredRepoRootedTests`
 * returns `[]` forever and reads as "nothing new to declare".
 *
 * `deps` exists so the sentinel's own rejection paths can be driven with broken
 * collaborators. A sentinel whose failure branches have never executed is the
 * thing it was written to prevent.
 *
 * Returns a sentence naming what is broken, or `null`.
 */
export function selfTestFailure(deps: Partial<SelfTestDeps> = {}): string | null {
  const {
    entries = ALWAYS_RUN_TESTS,
    detect = undeclaredRepoRootedTests,
    targets = coverageTargets,
    build = buildVitestArgv,
  } = deps;

  const shape = validateAlwaysRun(entries);
  if (shape !== null) return shape;

  const cwdProbe = "const root = process.cwd();\nreadFileSync(root + '/x');";
  const dirnameProbe = "readFileSync(resolve(__dirname, '../../lib/x.ts'));";
  const innocent = "const x = 1;\nexpect(x).toBe(1);\nconst p = tmpdir() + '/scratch';";
  const probes: Record<string, string> = {
    'tests/a.test.ts': cwdProbe,
    'tests/b.test.ts': dirnameProbe,
    'tests/c.test.ts': innocent,
  };

  const found = detect(Object.keys(probes), (path) => probes[path] ?? null);
  if (
    found.length !== 2 ||
    !found.includes('tests/a.test.ts') ||
    !found.includes('tests/b.test.ts')
  ) {
    return `The repo-rooted-read detector matched ${JSON.stringify(found)}; expected a.test.ts and b.test.ts.`;
  }

  // And that a declared file is subtracted — otherwise the list is decoration.
  //
  // Probes with `ALWAYS_RUN_TESTS[0]`, not `entries[0]`:
  // `undeclaredRepoRootedTests` subtracts the module-level list, so a caller
  // injecting its own valid `entries` — the shape `SelfTestDeps` advertises,
  // and what a fork's roster would look like — made this branch report a fault
  // in a list that was fine. A self-test that fails on correct input is the
  // same defect as one that passes on broken input.
  if (detect([ALWAYS_RUN_TESTS[0].path], () => cwdProbe).length !== 0) {
    return 'A declared always-run test was still reported as undeclared.';
  }

  if (targets(['lib/a.ts', 'tests/x.test.ts', 'types/y.d.ts', 'README.md']).join() !== 'lib/a.ts') {
    return 'coverageTargets no longer filters tests, declarations and non-TypeScript paths.';
  }

  const argv = build({ selected: [], alwaysRun: [], coverage: ['lib/a.ts'], threshold: 80 });
  if (!argv.includes('--coverage.thresholds.perFile=true')) {
    return 'buildVitestArgv stopped asking for per-file coverage thresholds.';
  }

  return null;
}
