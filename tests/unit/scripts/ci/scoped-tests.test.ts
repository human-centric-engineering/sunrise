/**
 * Tests for the scoped-run selector.
 *
 * The failure this file is really written against is a selector that quietly
 * runs fewer tests than it claims. Three shapes of that, all covered below:
 *
 * - **An always-run entry that no longer exists.** A rename upstream turns the
 *   entry into a no-op, the runner selects one fewer invariant, and every run
 *   afterwards is green for a reason nobody chose. Hence the on-disk check —
 *   which is also why this file is itself in `ALWAYS_RUN_TESTS`.
 * - **A detector that stops matching.** `undeclaredRepoRootedTests` returning
 *   `[]` reads as "nothing to declare", so the tests below assert it matches
 *   *and* that a sabotaged input still comes back non-empty.
 * - **`buildVitestArgv` intersecting instead of uniting.** vitest narrows
 *   positional filters against `--changed`, so the union has to be computed
 *   here; a version that dropped the always-run files would still produce a
 *   passing run.
 *
 * @see scripts/ci/scoped-tests.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ALWAYS_RUN_TESTS,
  alwaysRunPaths,
  buildVitestArgv,
  coverageTargets,
  selfTestFailure,
  undeclaredRepoRootedTests,
  unsafeArgvPaths,
  validateAlwaysRun,
  type ScopedRunPlan,
} from '@/scripts/ci/scoped-tests';

/** A reader backed by a literal map — nothing exists unless the test says so. */
function reader(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

const plan = (overrides: Partial<ScopedRunPlan> = {}): ScopedRunPlan => ({
  selected: [],
  alwaysRun: [],
  coverage: [],
  threshold: 80,
  ...overrides,
});

describe('ALWAYS_RUN_TESTS', () => {
  it('names only files that exist in this tree', () => {
    const missing = alwaysRunPaths().filter((path) => !existsSync(resolve(process.cwd(), path)));
    expect(missing).toEqual([]);
  });

  it('gives every entry a reason', () => {
    const bare = ALWAYS_RUN_TESTS.filter((entry) => entry.reason.trim().length < 20);
    expect(bare).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(alwaysRunPaths()).size).toBe(ALWAYS_RUN_TESTS.length);
  });

  it('includes the privacy export manifest guard, which no module graph reaches', () => {
    // Named explicitly rather than left to the count: dropping this one entry
    // stops a scoped run enforcing what a data subject receives, and CLAUDE.md
    // calls that manifest out as the thing never to quietly shorten.
    expect(alwaysRunPaths()).toContain('tests/unit/lib/privacy/export-sources.test.ts');
  });
});

describe('undeclaredRepoRootedTests', () => {
  it('flags a test that reads from process.cwd()', () => {
    const files = { 'tests/x.test.ts': "readFileSync(join(process.cwd(), 'lib/a.ts'));" };
    expect(undeclaredRepoRootedTests(Object.keys(files), reader(files))).toEqual([
      'tests/x.test.ts',
    ]);
  });

  it('flags a __dirname path that climbs out of tests/', () => {
    const files = { 'tests/x.test.ts': "readFileSync(resolve(__dirname, '../../lib/a.ts'));" };
    expect(undeclaredRepoRootedTests(Object.keys(files), reader(files))).toEqual([
      'tests/x.test.ts',
    ]);
  });

  it('leaves a test that only touches a temp dir alone', () => {
    const files = { 'tests/x.test.ts': "const dir = mkdtempSync(join(tmpdir(), 'scoped-'));" };
    expect(undeclaredRepoRootedTests(Object.keys(files), reader(files))).toEqual([]);
  });

  it('subtracts files already declared, so the list is not decoration', () => {
    const declared = alwaysRunPaths()[0];
    const files = { [declared]: 'process.cwd()' };
    expect(undeclaredRepoRootedTests(Object.keys(files), reader(files))).toEqual([]);
  });

  it('reports nothing for a file it cannot read, rather than throwing', () => {
    expect(undeclaredRepoRootedTests(['tests/gone.test.ts'], () => null)).toEqual([]);
  });

  it('matches the real source of a real tree-reading test', () => {
    // The anti-green-bar assertion, and it has to read the file off disk to be
    // one. An earlier version of this test passed a hardcoded literal as the
    // reader and only `existsSync`-checked the real path — so the detector was
    // never shown actual source, and a regex that stopped matching real code
    // (precisely what `selfTestFailure` exists to catch) would have sailed
    // through it. `/code-review` caught that; this reads the file.
    const target = 'tests/unit/lib/security/outbound-fetch-redirects.test.ts';
    const absolute = resolve(process.cwd(), target);
    expect(existsSync(absolute)).toBe(true);

    const read = (path: string): string | null =>
      path === target ? readFileSync(absolute, 'utf8') : null;

    // Under a pretend name it is undeclared, so a working detector reports it.
    expect(
      undeclaredRepoRootedTests(['tests/unit/pretend-undeclared.test.ts'], () =>
        readFileSync(absolute, 'utf8')
      )
    ).toEqual(['tests/unit/pretend-undeclared.test.ts']);

    // Under its real name it is declared, so the subtraction hides it. Both
    // halves matter: the first proves the regex still matches real source, the
    // second proves the list is doing the subtracting.
    expect(undeclaredRepoRootedTests([target], read)).toEqual([]);
  });
});

describe('coverageTargets', () => {
  it('keeps TypeScript sources and drops everything else', () => {
    expect(
      coverageTargets([
        'lib/a.ts',
        'components/b.tsx',
        'tests/unit/a.test.ts',
        'types/c.d.ts',
        'README.md',
        'prisma/schema/app.prisma',
      ])
    ).toEqual(['components/b.tsx', 'lib/a.ts']);
  });

  it('drops a colocated test file, not just the tests/ tree', () => {
    // The selection side accepts a fork's `.spec.ts`, so this side has to agree
    // about where tests live. `vitest.config.ts`'s coverage.exclude lists
    // `tests/` only, so nothing downstream catches these either — a fork that
    // colocates would have had its own test files held to the 80% floor.
    expect(
      coverageTargets(['lib/foo.ts', 'lib/foo.test.ts', 'lib/bar.spec.tsx', 'lib/baz.test.mts'])
    ).toEqual(['lib/foo.ts']);
  });

  it('leaves config exclusions to vitest.config.ts rather than filtering them here', () => {
    // `lib/env.ts` and App Router boundary files are excluded by the coverage
    // config, which still wins over a CLI `--coverage.include` (verified
    // against vitest 4.1.10). Filtering them a second time here would be a
    // duplicate rule free to drift from the config.
    expect(coverageTargets(['lib/env.ts', 'app/(public)/layout.tsx'])).toEqual([
      'app/(public)/layout.tsx',
      'lib/env.ts',
    ]);
  });
});

describe('buildVitestArgv', () => {
  it('unions the selected and always-run sets rather than intersecting them', () => {
    const argv = buildVitestArgv(
      plan({ selected: ['tests/a.test.ts'], alwaysRun: ['tests/b.test.ts'] })
    );
    expect(argv).toEqual(['run', 'tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('de-duplicates a file that is both selected and always-run', () => {
    const argv = buildVitestArgv(
      plan({ selected: ['tests/a.test.ts'], alwaysRun: ['tests/a.test.ts'] })
    );
    expect(argv).toEqual(['run', 'tests/a.test.ts']);
  });

  it('asks for no coverage flags when nothing is gated', () => {
    expect(buildVitestArgv(plan({ selected: ['tests/a.test.ts'] })).join(' ')).not.toContain(
      'coverage'
    );
  });

  it('scopes coverage to the changed files and applies the floor per file', () => {
    const argv = buildVitestArgv(plan({ coverage: ['lib/a.ts', 'lib/b.ts'], threshold: 80 }));
    expect(argv).toContain('--coverage');
    expect(argv).toContain('--coverage.include=lib/a.ts');
    expect(argv).toContain('--coverage.include=lib/b.ts');
    // Without perFile the floor is an average over the included set, which one
    // well-covered file carries for a bare one.
    expect(argv).toContain('--coverage.thresholds.perFile=true');
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      expect(argv).toContain(`--coverage.thresholds.${metric}=80`);
    }
  });

  it('glob-escapes a route group, which would otherwise gate nothing', () => {
    // `(protected)` is extglob alternation to picomatch, so the unescaped path
    // matches no file: empty coverage table, no threshold to fail, exit 0.
    // Verified against vitest 4.1.10 both ways.
    expect(buildVitestArgv(plan({ coverage: ['app/(protected)/dashboard/page.tsx'] }))).toContain(
      '--coverage.include=app/\\(protected\\)/dashboard/page.tsx'
    );
  });

  it('glob-escapes a catch-all route segment', () => {
    expect(buildVitestArgv(plan({ coverage: ['app/api/auth/[...all]/route.ts'] }))).toContain(
      '--coverage.include=app/api/auth/\\[...all\\]/route.ts'
    );
  });

  it('does not pass coverage.all, which vitest 4 removed', () => {
    // It was accepted as a nested key and silently ignored, so the comment and
    // the test that asserted it both described behaviour that never happened.
    // Worse if it had worked: suppressing untested-but-included files is
    // exactly what would break the "a changed file with no test reports as 0%"
    // guarantee the docs rest on.
    expect(buildVitestArgv(plan({ coverage: ['lib/a.ts'] })).join(' ')).not.toContain(
      'coverage.all'
    );
  });

  it('honours a threshold other than the default', () => {
    expect(buildVitestArgv(plan({ coverage: ['lib/a.ts'], threshold: 95 }))).toContain(
      '--coverage.thresholds.lines=95'
    );
  });
});

describe('unsafeArgvPaths', () => {
  it('rejects a path that would arrive as a vitest option', () => {
    // The shape a newline-named file produces: `vitest list` prints it across
    // two lines, and the second fragment becomes its own argv token. vitest
    // reads options wherever they appear, so this would replace the run's
    // whole config — setupFiles and the coverage exclude list included.
    expect(unsafeArgvPaths(['tests/ok.test.ts', '--config=payload.test.ts'])).toEqual([
      '--config=payload.test.ts',
    ]);
  });

  it('rejects a git C-quoted path instead of letting the extension filter eat it', () => {
    // git C-quotes any path with a control character even under
    // core.quotePath=false, so it stops ending in `.ts` and would fall out of
    // coverageTargets in silence — a changed source file leaving the coverage
    // gate with nothing said.
    const quoted = '"lib/we\\nird.ts"';
    expect(unsafeArgvPaths([quoted])).toEqual([quoted]);
    expect(coverageTargets([quoted])).toEqual([]);
  });

  it('rejects a raw control character anywhere in the path', () => {
    const nl = 'lib/a\u000ab.ts';
    const tab = 'lib/a\u0009b.ts';
    const del = 'lib/a\u007fb.ts';
    expect(unsafeArgvPaths([nl, tab, del])).toEqual([nl, tab, del]);
  });

  it('leaves ordinary paths alone, including dashes that are not leading', () => {
    expect(
      unsafeArgvPaths(['tests/unit/lib/some-file.test.ts', 'app/(public)/page.tsx', 'lib/a_b.ts'])
    ).toEqual([]);
  });
});

describe('validateAlwaysRun', () => {
  it('accepts the list as shipped', () => {
    expect(validateAlwaysRun(ALWAYS_RUN_TESTS)).toBeNull();
  });

  it('rejects an empty list, which would silently skip every invariant', () => {
    expect(validateAlwaysRun([])).toContain('empty');
  });

  it('rejects a path that is not under tests/', () => {
    expect(validateAlwaysRun([{ path: 'lib/a.ts', reason: 'x'.repeat(30) }])).toContain(
      'not a test path'
    );
  });

  it('rejects a path that is not a .test.ts file', () => {
    expect(validateAlwaysRun([{ path: 'tests/a.ts', reason: 'x'.repeat(30) }])).toContain(
      'not a test path'
    );
  });

  it('rejects an entry with no reason, because the reason is what stops the list rotting', () => {
    expect(validateAlwaysRun([{ path: 'tests/a.test.ts', reason: '   ' }])).toContain('no reason');
  });
});

describe('selfTestFailure', () => {
  it('passes on the module as shipped', () => {
    expect(selfTestFailure()).toBeNull();
  });

  it('reports a broken list before it reports anything else', () => {
    expect(selfTestFailure({ entries: [] })).toContain('empty');
  });

  it('catches a detector that has stopped matching', () => {
    // The failure mode the sentinel exists for: `[]` from a dead regex reads
    // as "nothing new to declare" at every call site.
    expect(selfTestFailure({ detect: () => [] })).toContain('detector matched');
  });

  it('catches a detector that stopped subtracting the declared list', () => {
    // Matches the two probes as expected, but also reports a declared file —
    // so the first check passes and only the second can see the fault.
    const detect = (files: readonly string[]): string[] =>
      files.filter((path) => path !== 'tests/c.test.ts');
    expect(selfTestFailure({ detect })).toContain('still reported as undeclared');
  });

  it('catches coverageTargets letting a test file through', () => {
    expect(selfTestFailure({ targets: (changed) => [...changed] })).toContain('coverageTargets');
  });

  it('catches buildVitestArgv dropping the per-file threshold', () => {
    expect(selfTestFailure({ build: () => ['run'] })).toContain('per-file coverage');
  });

  it('passes for a caller injecting its own valid entries list', () => {
    // `SelfTestDeps` advertises `entries` as injectable, and a fork's roster is
    // exactly that shape. The subtraction probe used to test `entries[0]`
    // against a detector that subtracts the module-level list, so any custom
    // list — however correct — was reported as broken. A self-test that fails
    // on good input is the same defect as one that passes on bad input.
    const fork = [{ path: 'tests/unit/fork-thing.test.ts', reason: 'x'.repeat(30) }];
    expect(selfTestFailure({ entries: fork })).toBeNull();
  });
});
