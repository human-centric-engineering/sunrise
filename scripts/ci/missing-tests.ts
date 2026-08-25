/**
 * "Does this changed file have a test?" — the rules, pure, no IO.
 *
 * `/pre-pr` step 4f asks that question for every file a branch added or
 * modified. Until #641 it asked it in **prose**, which meant every agent wrote
 * its own scanner, in whatever shell it happened to have, on every run. Twelve
 * of step 4's thirteen checks were in that state; this one was singled out
 * because it is the one whose rules are mechanical — path arithmetic plus a
 * list of exceptions — so re-deriving them by hand buys nothing and loses
 * something every time.
 *
 * **The failure mode is silence, not a wrong answer.** A hand-rolled scan that
 * cannot run prints nothing, and nothing is indistinguishable from a pass. The
 * instance that opened #641 used `compgen` — a bash builtin — in a zsh agent
 * shell: the loop produced no output and was very nearly banked as a clean
 * tree. Re-run with a deliberately bogus filename appended, it immediately
 * found two real entries. Hence {@link selfTestFailure}, which the CLI runs
 * before every real scan.
 *
 * # What "has a test" means here, and why it is three answers not two
 *
 * The obvious rule — mirror the source path under `tests/unit/` — is right for
 * most of this repo and **wrong often enough to matter**. Measured by running
 * {@link classify} over every tracked `.ts`/`.tsx` (`git ls-files`) at the time
 * of writing — 2301 files, 1146 of them non-exempt:
 *
 * - **367 have no mirrored test** (1146 minus the 779 the mirror rule finds).
 * - **258 of those are covered some other way** — 240 named by a test file, 14
 *   by the collapsed parent of a dynamic route, 4 by an aspect-named sibling
 *   (`config-sendResetPassword.test.ts` for `lib/auth/config.ts`). The rest of
 *   the 240 are enumerating tests that walk a directory
 *   (`fork-init-seams.test.ts` over `lib/app/*`) and route tests a level up.
 * - **109 are genuine gaps.**
 *
 * So a mirror-only scanner reports 367 findings of which 258 are false. That
 * ratio is the whole argument for this file.
 *
 * Re-derive rather than trust these numbers, and say what you counted: "no
 * mirrored test" (367) and "no test by any rule" (349) are different questions,
 * and an unstated denominator is how two honest counts disagree.
 *
 * So the verdict has three values, not two:
 *
 * - `covered`   — a test file sits where one is expected. Nothing to say.
 * - `referenced` — no mirrored test, but some test file names the module.
 *   Reported, with the test named, because the reader can judge in one glance
 *   what the scanner cannot: whether that is real exercise or a `vi.mock` of a
 *   dependency. This is a **weaker** signal deliberately, not a pass.
 * - `missing`   — no mirrored test and no test mentions it at all.
 *
 * Collapsing `referenced` into `covered` hides genuine gaps; collapsing it into
 * `missing` turns 109 findings into 349 and trains people to skim. The
 * distinction is the whole reason this is a module and not a `grep`.
 *
 * # Exemptions
 *
 * Two kinds, and they behave differently:
 *
 * - **By path** — `tests/**`, `*.d.ts`, root-level tool configs, `public/`,
 *   `.claude/`, and the App Router boundary files (`layout` / `loading` /
 *   `error` / `not-found`). A near-subset of `vitest.config.ts`'s
 *   `coverage.exclude`; the four places it deliberately differs are listed in
 *   {@link NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION} with a reason each, and a
 *   test fails if the lists drift any further apart. Taking the coverage list
 *   wholesale — the obvious move — would have exempted `prisma/`, `emails/`
 *   and `types/`, all three of which this repo actively tests.
 * - **By content** — a barrel that only re-exports, and a module that declares
 *   no runtime value at all. Neither can be decided from the filename, which is
 *   exactly why hand-rolled versions get them wrong: exempting every `index.ts`
 *   by name hides the 14 index files in this repo that carry their own code (9
 *   of which have no mirrored test), and not exempting type-only modules flags
 *   16 files that compile to nothing.
 *
 * Content rules go through the TypeScript compiler rather than a regex, for the
 * same reason `exports-diff.ts` does: a regex cannot tell `export type { X }`
 * from `export { X }`, and getting that backwards silently exempts real code.
 *
 * The two lists are allowed to differ. They are just not allowed to differ by
 * accident, which is what the drift test is for.
 *
 * @see scripts/ci/check-missing-tests.ts — the CLI that reads git and the disk
 * @see .claude/commands/pre-pr.md — step 4f, which runs it
 */

import ts from 'typescript';

/** A file as `git diff --name-status` reported it. */
export interface ChangedFile {
  /** Repo-relative, forward slashes. For a rename, the destination path. */
  path: string;
  /** `A`dded, `M`odified, or `R`enamed — the statuses 4f asks about. */
  status: 'A' | 'M' | 'R';
}

/** How a file came to be considered covered. */
export type CoverageRoute =
  /** `lib/x/y.ts` → `tests/unit/lib/x/y.test.ts`. */
  | 'mirror'
  /** `app/api/v1/foo/[id]/route.ts` → `tests/unit/app/api/v1/foo/route.test.ts`. */
  | 'collapsed-dynamic-segment'
  /** `lib/auth/config.ts` → `tests/unit/lib/auth/config-signup-mode.test.ts`. */
  | 'aspect';

/** The verdict for one changed file. */
export type Outcome =
  | { kind: 'exempt'; reason: string }
  | { kind: 'covered'; testPath: string; via: CoverageRoute }
  | { kind: 'referenced'; referencedBy: string[] }
  | { kind: 'missing'; expected: string[] };

export interface Verdict {
  path: string;
  /** What git said happened to it. Surfaced for renames — see {@link classifyOne}. */
  status: ChangedFile['status'];
  outcome: Outcome;
}

/** Everything {@link classify} needs from the world, injected so it stays pure. */
export interface ClassifyContext {
  /** Every test file in the tree, repo-relative. Order is irrelevant. */
  testFiles: readonly string[];
  /** Source text of a repo-relative path, or `null` if it cannot be read. */
  readSource: (path: string) => string | null;
  /** Test files whose text names this module's `@/` specifier(s). */
  referencesOf: (specifiers: readonly string[]) => readonly string[];
}

const TEST_ROOTS = ['tests/unit/', 'tests/integration/'] as const;
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'] as const;

/**
 * Paths `vitest.config.ts` excludes from coverage that 4f still asks about,
 * with the reason each one differs. Exported so
 * `tests/unit/scripts/ci/missing-tests.test.ts` can assert the two lists differ
 * only here — a coverage exclusion added upstream must be a decision, not a
 * silent widening of what this check ignores.
 *
 * Every entry is measured, not assumed. Copying the coverage list wholesale —
 * the obvious move, and the one a hand-rolled scanner makes — would have
 * exempted three trees this repo actively tests.
 */
export const NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION: ReadonlyArray<{
  pattern: string;
  reason: string;
}> = [
  {
    pattern: '**/types/**',
    reason:
      'three of the seven files under `types/` declare runtime values — ' +
      '`types/mcp.ts` alone exports the protocol-version negotiator. The ' +
      'content rule exempts the other four — three type-only, one a pure barrel.',
  },
  {
    pattern: 'prisma/',
    reason: '`prisma/runner.ts` and the seed units have tests under `tests/unit/prisma/`.',
  },
  {
    pattern: 'emails/',
    reason: 'every shipped template has a test under `tests/unit/emails/`.',
  },
  {
    pattern: 'lib/env.ts',
    reason:
      'coverage skips it for its import-time validation side effects, not ' +
      'because it needs no test — it has three.',
  },
  {
    pattern: 'scripts/db/!(*-assertions).ts',
    reason:
      'coverage skips `scripts/db/check-drift.ts` because it probes a live ' +
      'database and nothing imports it, so its 0% is structural. 4f still ' +
      'asks, and should: most of the drift primitives it drives live in ' +
      '`lib/db/drift-probes.ts` and are tested there, but not all — ' +
      '`englishTsConfigExists` is defined in the excluded file itself, and ' +
      'there is no `tests/unit/scripts/db/` at all. If a probe script grows ' +
      'pure logic of its own, the `*-assertions.ts` convention keeps it gated.',
  },
  {
    pattern: 'scripts/smoke/!(*-assertions).ts',
    reason:
      'coverage skips the harnesses because vitest never executes these ' +
      'standalone tsx entry points, so their 0% is structural rather than a ' +
      'gap. 4f still asks about them: it reports and never gates, so a ' +
      'harness is answered in review rather than silenced here. Note the ' +
      'coverage pattern deliberately spares `*-assertions.ts` — the pure ' +
      'logic a harness extracts to be testable, which is covered and gated ' +
      'like any other source file.',
  },
];

/**
 * Path prefixes and filename rules that put a file out of 4f's scope.
 *
 * Deliberately short. Anything decidable from content is decided by
 * {@link contentExemption} instead, because a path rule cannot tell a barrel
 * from a module that happens to be called `index.ts`, and exempting is the
 * answer that hides work.
 */
const PATH_EXEMPTIONS: ReadonlyArray<{ test: (path: string) => boolean; reason: string }> = [
  { test: (p) => p.startsWith('tests/'), reason: 'is a test' },
  { test: (p) => p.endsWith('.d.ts'), reason: 'type declarations only' },
  {
    // Root level only, matching the coverage config's own comment:
    // `next.config.ts`, `vitest.config.ts`, `tailwind.config.ts`. A nested
    // `*.config.ts` is application code and is not exempt.
    test: (p) => !p.includes('/') && /\.config\.(js|ts|mjs|cjs)$/.test(p),
    reason: 'root-level tool config',
  },
  { test: (p) => p.startsWith('public/'), reason: 'not source' },
  { test: (p) => p.startsWith('.claude/'), reason: 'not application code' },
  {
    // Named by 4f itself. Excluded from coverage too, and there is nothing in
    // them to assert beyond that they render.
    test: (p) => /^app\/(?:.*\/)?(layout|loading|error|not-found)\.tsx$/.test(p),
    reason: 'App Router boundary file',
  },
  {
    // Fork-owned placeholder marketing copy. Every fork rewrites or deletes
    // this page, so a core test pinning its sections, tiers or FAQ items is a
    // core test a fork cannot satisfy — the #480 / #525 / #530 / #533 class.
    // Excluded from coverage for the same reason; the two must agree, which is
    // what the accounting check in missing-tests.test.ts enforces.
    //
    // The real exposure — this file being overwritten wholesale by another
    // route module, which has happened — is covered structurally by
    // `tests/unit/app/route-module-distinctness.test.ts`, with no opinion about
    // what the page says.
    test: (p) => p === 'app/(public)/page.tsx',
    reason: 'fork-owned placeholder page (see its docblock)',
  },
];

/** `lib/x/y.tsx` → `lib/x/y`; `null` for anything that is not a TS source. */
export function sourceStem(path: string): string | null {
  if (path.endsWith('.d.ts')) return null;
  if (path.endsWith('.tsx')) return path.slice(0, -'.tsx'.length);
  if (path.endsWith('.ts')) return path.slice(0, -'.ts'.length);
  return null;
}

/** The stems a test path may mirror: the source's own, and `app/`-stripped. */
function stemVariants(stem: string): string[] {
  const variants = [stem];
  if (stem.startsWith('app/')) variants.push(stem.slice('app/'.length));
  return variants;
}

/**
 * Where a mirrored test for this source would live.
 *
 * Both roots and both suffixes, and — for `app/` sources — the `app/`-stripped
 * form, because `tests/integration/api/v1/users/route.test.ts` is the shape
 * this repo actually uses for route handlers. Order matters only for the hint
 * the report prints; membership is what decides the verdict.
 */
export function mirrorCandidates(stem: string, sourceExtension?: 'ts' | 'tsx'): string[] {
  // Ordered so `expected[0]` is the path a reader should actually create: a
  // `.tsx` component wants a `.test.tsx`, and suggesting `.test.ts` for one
  // sends them to write a file the mirror rule will then not find.
  const suffixes: readonly string[] =
    sourceExtension === 'tsx' ? ['.test.tsx', '.test.ts'] : TEST_SUFFIXES;
  const out: string[] = [];
  for (const variant of stemVariants(stem)) {
    for (const root of TEST_ROOTS) {
      for (const suffix of suffixes) out.push(`${root}${variant}${suffix}`);
    }
  }
  return out;
}

/**
 * The same candidates with `[dynamic]` segments dropped.
 *
 * A route under `app/api/v1/foo/[id]/` is often tested from
 * `tests/unit/app/api/v1/foo/route.test.ts` alongside the collection handler.
 * This is a **fallback**, tried after {@link mirrorCandidates}: the repo has
 * bracketed directories under `tests/` too, so most dynamic routes are found by
 * the plain mirror and only the co-located ones need this.
 *
 * Returns `[]` when the path has no dynamic segment, so a caller cannot
 * accidentally re-test the mirror set.
 */
export function collapsedDynamicCandidates(stem: string): string[] {
  const segments = stem.split('/');
  const kept = segments.filter((segment) => !(segment.startsWith('[') && segment.endsWith(']')));
  if (kept.length === segments.length) return [];
  return mirrorCandidates(kept.join('/'));
}

/**
 * Matches an aspect-named sibling: `config.ts` ← `config-signup-mode.test.ts`,
 * `orchestration.ts` ← `orchestration.supervisor.test.ts`. Five files in this
 * repo are covered only this way.
 *
 * **A candidate that is some other module's mirror test is not an aspect of
 * this one.** `lib/security/rate-limit.ts` and `rate-limit-policy.ts` are
 * different modules; a prefix match alone hands the first one the second one's
 * test, so a real gap in `rate-limit.ts` would read as covered. Kebab-case
 * module names make that collision ordinary rather than exotic — `rate-limit`
 * has four such siblings — so the candidate's own source is checked, and if it
 * exists the test belongs to it.
 *
 * **Including when that source is a directory barrel.** The first version
 * checked `${own}.ts` and `${own}.tsx` only, which correctly rejected
 * `rate-limit-policy.test.ts` (a flat file) and still credited
 * `rate-limit-stores.test.ts` to `rate-limit.ts`, because
 * `rate-limit-stores/` is a folder with an `index.ts`. Same collision, one
 * shape further out.
 *
 * Today `rate-limit.ts` has its own mirror test, which wins before this
 * function is reached; the guard is here because the next kebab-cased pair will
 * not.
 */
export function aspectTestsFor(
  stem: string,
  testFiles: readonly string[],
  sourceExists: (path: string) => boolean
): string[] {
  const prefixes = stemVariants(stem).flatMap((variant) =>
    TEST_ROOTS.map((root) => `${root}${variant}`)
  );

  const belongsToAnotherModule = (file: string): boolean => {
    const root = TEST_ROOTS.find((candidate) => file.startsWith(candidate));
    if (root === undefined) return false;
    const suffix = TEST_SUFFIXES.find((candidate) => file.endsWith(candidate));
    if (suffix === undefined) return false;
    const own = file.slice(root.length, -suffix.length);
    // A **directory barrel** counts too. Checking only `${own}.ts` missed
    // `rate-limit-stores/index.ts`, so `rate-limit.ts` was credited with
    // `rate-limit-stores.test.ts` — the shape this guard exists to reject,
    // slipping through because the sibling is a folder rather than a file.
    const shapes = (stemPath: string): string[] => [
      `${stemPath}.ts`,
      `${stemPath}.tsx`,
      `${stemPath}/index.ts`,
      `${stemPath}/index.tsx`,
    ];
    return [...shapes(own), ...shapes(`app/${own}`)].some(sourceExists);
  };

  return testFiles
    .filter((file) =>
      prefixes.some((prefix) => {
        if (!file.startsWith(prefix)) return false;
        const rest = file.slice(prefix.length);
        return /^[.-][^/]*\.test\.tsx?$/.test(rest);
      })
    )
    .filter((file) => !belongsToAnotherModule(file))
    .sort();
}

/** The `@/` specifiers an importer would use to reach this module directly. */
export function importSpecifiers(stem: string): string[] {
  const specifiers = [`@/${stem}`];
  // `lib/security/index.ts` is imported as `@/lib/security`.
  if (stem.endsWith('/index')) specifiers.push(`@/${stem.slice(0, -'/index'.length)}`);
  return specifiers;
}

/**
 * The directory specifier, when a sibling barrel pulls this module in.
 *
 * A test importing `@/prisma/seeds/data/templates` reaches every template
 * behind it without ever naming one, so a reference scan that only looks for a
 * module's own path calls all twelve untouched. Measured: 13 files are
 * reachable exactly this way — without the rule, `missing` would be 122 rather
 * than 109.
 *
 * **Both `import` and `export … from` count.** Restricting it to re-export
 * declarations was the first version and moved 1 of the 13: the barrels that
 * matter here `import` their siblings and aggregate them into one exported
 * value (`BUILTIN_WORKFLOW_TEMPLATES`), which is indirect exercise just the
 * same.
 *
 * The barrel must name **this** module. A directory that merely has an
 * `index.ts` proves nothing, and crediting one would let a whole folder ride on
 * one tested sibling.
 */
export function reexportingBarrelSpecifier(
  stem: string,
  readSource: (path: string) => string | null
): string | null {
  if (stem.endsWith('/index')) return null;
  const slash = stem.lastIndexOf('/');
  if (slash === -1) return null;
  const dir = stem.slice(0, slash);
  const basename = stem.slice(slash + 1);

  for (const barrel of [`${dir}/index.ts`, `${dir}/index.tsx`]) {
    const text = readSource(barrel);
    if (text === null) continue;
    const file = ts.createSourceFile(barrel, text, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      const isFromDeclaration =
        ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement);
      if (!isFromDeclaration) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
      // `@/` is what this repo uses (ESLint forbids relative imports); `./x` is
      // accepted anyway so the rule survives a fork that relaxes that.
      if (specifier.text === `@/${stem}` || specifier.text === `./${basename}`) {
        return `@/${dir}`;
      }
    }
  }
  return null;
}

/** Path-only exemption, or `null` if the file is in scope. */
export function pathExemption(path: string): string | null {
  for (const rule of PATH_EXEMPTIONS) {
    if (rule.test(path)) return rule.reason;
  }
  return null;
}

/**
 * Content-based exemption, decided by the compiler.
 *
 * Two shapes qualify, and both are things a filename cannot tell you:
 *
 * - **A pure barrel** — every top-level statement is `export … from '…'`. It
 *   has no behaviour of its own, so the thing to test is what it re-exports.
 * - **A type-only module** — no top-level statement emits runtime code.
 *   `tsc` is already the check for those; a test could only assert that types
 *   compile, which the build does.
 *
 * Both fail **closed**: an unreadable or unparseable file, or one statement
 * that is not on the allowlist, means "not exempt". Exempting is the answer
 * that hides work, so it needs positive evidence.
 */
export function contentExemption(path: string, source: string | null): string | null {
  if (source === null) return null;

  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const statements = file.statements;
  if (statements.length === 0) return null;

  const isReExport = (node: ts.Statement): boolean =>
    ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined;

  if (statements.every(isReExport)) return 'barrel — re-exports only';

  const emitsNothing = (node: ts.Statement): boolean => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
    // A **bare** import runs the module for its side effects, so it emits. The
    // first version returned true for every `ImportDeclaration`, which made a
    // file whose whole body is `import '@/…';` read as declaring nothing —
    // and `lib/orchestration/engine/executors/index.ts` is exactly that shape:
    // 19 imports whose only purpose is to call `registerStepType()`. Dropping
    // or reordering one is a real regression, and it was exempt from 4f.
    if (ts.isImportDeclaration(node)) return node.importClause !== undefined;
    if (ts.isExportDeclaration(node)) return node.isTypeOnly;
    // `declare module`, `declare global` — ambient, no emit.
    if (ts.isModuleDeclaration(node)) {
      return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;
    }
    return false;
  };

  if (statements.every(emitsNothing)) return 'declares no runtime value';

  return null;
}

/**
 * Runs every rule over one changed file.
 *
 * The verdict carries git's status through so the report can mark a **rename**.
 * A renamed module whose test did not move with it is an ordinary gap and reads
 * very differently from a brand-new file with no test — and the field was
 * recorded and then never read until this said so.
 */
export function classifyOne(
  file: ChangedFile,
  context: ClassifyContext,
  /** Prebuilt from `context.testFiles`; `classify` builds it once for the run. */
  testSet?: ReadonlySet<string>
): Verdict {
  const { path, status } = file;

  const byPath = pathExemption(path);
  if (byPath !== null) return { path, status, outcome: { kind: 'exempt', reason: byPath } };

  const stem = sourceStem(path);
  if (stem === null)
    return { path, status, outcome: { kind: 'exempt', reason: 'not a TypeScript source' } };

  const byContent = contentExemption(path, context.readSource(path));
  if (byContent !== null) return { path, status, outcome: { kind: 'exempt', reason: byContent } };

  const tests = testSet ?? new Set(context.testFiles);

  // The mirror is the one route that needs no corroboration: a test at exactly
  // the mirrored path is about this module by construction.
  const mirrors = mirrorCandidates(stem, path.endsWith('.tsx') ? 'tsx' : 'ts');
  const mirror = mirrors.find((candidate) => tests.has(candidate));
  if (mirror !== undefined) {
    return { path, status, outcome: { kind: 'covered', testPath: mirror, via: 'mirror' } };
  }

  const specifiers = importSpecifiers(stem);
  const viaBarrel = reexportingBarrelSpecifier(stem, context.readSource);
  if (viaBarrel !== null) specifiers.push(viaBarrel);
  const referencedBy = context.referencesOf(specifiers);
  const names = new Set(referencedBy);

  // **Every other route must be corroborated by the test naming the module.**
  //
  // Both fallbacks are guesses from a path, and a guess that credits the wrong
  // test prints `covered` over something nothing tests — the silent pass this
  // module exists to prevent. Three review rounds each found one instance of
  // that shape before it was closed as a class rather than patched again:
  // `aspectTestsFor` missing directory barrels, then bare side-effect imports
  // exempting a registration barrel, then this — `collapsedDynamicCandidates`
  // had no guard at all and credited 8 dynamic routes to a collection sibling's
  // mirror test that never imports them.
  //
  // Measured at the time of writing: of the 27 credits the two fallbacks would
  // hand out, 18 are corroborated and 9 are not. The 9 do not disappear — they fall through to
  // `referenced`, which is the honest answer for them.
  const corroborated = (candidate: string): boolean => names.has(candidate);

  const collapsed = collapsedDynamicCandidates(stem).find(
    (candidate) => tests.has(candidate) && corroborated(candidate)
  );
  if (collapsed !== undefined) {
    return {
      path,
      status,
      outcome: { kind: 'covered', testPath: collapsed, via: 'collapsed-dynamic-segment' },
    };
  }

  const aspects = aspectTestsFor(stem, context.testFiles, (p) => context.readSource(p) !== null);
  const aspect = aspects.find(corroborated);
  if (aspect !== undefined) {
    return { path, status, outcome: { kind: 'covered', testPath: aspect, via: 'aspect' } };
  }

  if (referencedBy.length > 0) {
    return {
      path,
      status,
      outcome: { kind: 'referenced', referencedBy: [...referencedBy].sort() },
    };
  }

  return { path, status, outcome: { kind: 'missing', expected: mirrors } };
}

/** Runs every rule over every changed file, preserving input order. */
export function classify(files: readonly ChangedFile[], context: ClassifyContext): Verdict[] {
  // Built once. `classifyOne` would otherwise rebuild a 1097-entry Set per
  // changed file — 1.25M inserts on a whole-repo run.
  const testSet = new Set(context.testFiles);
  return files.map((file) => classifyOne(file, context, testSet));
}

/**
 * Proves the classifier can still report, on synthetic input, before a real
 * run. Returns a description of the first broken expectation, or `null`.
 *
 * This is #641's rule made unskippable rather than remembered: *a scan that
 * cannot demonstrate it would report a hit is not evidence of anything*. It
 * covers the classifier only — the CLI has its own guards for the halves this
 * cannot see (git failing, the test index coming back empty), because those are
 * where the shell-shaped failures actually happen.
 *
 * `classifier` exists so the self-test can itself be falsified: a check that
 * cannot be shown to fail is the thing this file is about.
 */
export function selfTestFailure(
  classifier: (file: ChangedFile, context: ClassifyContext) => Verdict = classifyOne
): string | null {
  const testFiles = [
    'tests/unit/lib/sentinel/covered.test.ts',
    'tests/unit/lib/sentinel/aspect-flavour.test.ts',
    'tests/unit/lib/sentinel/uncorroborated-flavour.test.ts',
    'tests/unit/app/api/v1/sentinel/route.test.ts',
    'tests/unit/lib/sentinel/importer.test.ts',
  ];

  // Only the sentinel's own sources exist. A reader that answers every path —
  // the first version here — makes every aspect candidate look like some other
  // module's mirror test, and the aspect case failed. Which is the self-test
  // doing its job, and the reason it takes a realistic world rather than a
  // convenient one.
  const sources = new Set([
    'lib/sentinel/never-tested.ts',
    'lib/sentinel/covered.ts',
    'lib/sentinel/aspect.ts',
    'lib/sentinel/uncorroborated.ts',
    'lib/sentinel/referenced.ts',
    'app/api/v1/sentinel/[id]/route.ts',
  ]);

  // Which test files name which module. Every non-mirror credit needs one, so
  // the sentinel has to model that rather than answer a flat yes/no.
  const named: Record<string, string[]> = {
    '@/lib/sentinel/aspect': ['tests/unit/lib/sentinel/aspect-flavour.test.ts'],
    '@/lib/sentinel/referenced': ['tests/unit/lib/sentinel/importer.test.ts'],
    '@/app/api/v1/sentinel/[id]/route': ['tests/unit/app/api/v1/sentinel/route.test.ts'],
    // `uncorroborated` is deliberately absent: a test sits at its aspect path
    // and never names it.
  };

  const context: ClassifyContext = {
    testFiles,
    readSource: (path) =>
      sources.has(path) ? 'export function live(): number { return 1; }' : null,
    referencesOf: (specifiers) => specifiers.flatMap((specifier) => named[specifier] ?? []),
  };

  const cases: Array<{ file: ChangedFile; want: Outcome['kind']; why: string }> = [
    {
      file: { path: 'lib/sentinel/never-tested.ts', status: 'A' },
      want: 'missing',
      why: 'a file with no test anywhere must be reported',
    },
    {
      file: { path: 'lib/sentinel/covered.ts', status: 'M' },
      want: 'covered',
      why: 'a mirrored test must satisfy the check',
    },
    {
      file: { path: 'lib/sentinel/aspect.ts', status: 'M' },
      want: 'covered',
      why: 'an aspect-named sibling that names the module must satisfy the check',
    },
    {
      file: { path: 'lib/sentinel/uncorroborated.ts', status: 'M' },
      want: 'missing',
      why: 'a test at the aspect path that never names the module must NOT count as covered',
    },
    {
      file: { path: 'app/api/v1/sentinel/[id]/route.ts', status: 'A' },
      want: 'covered',
      why: 'a dynamic route must find its collapsed parent test',
    },
    {
      file: { path: 'lib/sentinel/referenced.ts', status: 'A' },
      want: 'referenced',
      why: 'a module only imported by a test must report as referenced, not clean',
    },
    {
      file: { path: 'tests/unit/lib/sentinel/covered.test.ts', status: 'M' },
      want: 'exempt',
      why: 'a test file must not be asked for a test of its own',
    },
  ];

  for (const { file, want, why } of cases) {
    const got = classifier(file, context).outcome.kind;
    if (got !== want) {
      return `${file.path}: expected \`${want}\`, got \`${got}\` — ${why}`;
    }
  }
  return null;
}
