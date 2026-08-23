/**
 * Tests for `/pre-pr` step 4f's rules.
 *
 * The headline cases are the two shapes a hand-rolled version of this check
 * gets wrong, and both are drawn from real instances rather than imagined:
 *
 * - **`page.tsx` loses nothing to `${f%.ts}`.** The shell parameter expansion
 *   an agent reaches for strips `.ts` only, so a `.tsx` file is looked up as
 *   `page.tsx.test.ts` — a path that never exists and never will, which means
 *   every `.tsx` file on the branch silently passes. That is a check that
 *   cannot fail, dressed as a clean result.
 * - **Exempting by filename.** Every `index.ts` looks like a barrel; 14 in this
 *   repo carry their own code.
 *
 * @see scripts/ci/missing-tests.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  aspectTestsFor,
  classifyOne,
  collapsedDynamicCandidates,
  contentExemption,
  importSpecifiers,
  mirrorCandidates,
  pathExemption,
  reexportingBarrelSpecifier,
  selfTestFailure,
  sourceStem,
  NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION,
  type ChangedFile,
  type ClassifyContext,
  type Verdict,
} from '@/scripts/ci/missing-tests';

/** A world where nothing exists unless the test says so. */
function context(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    testFiles: [],
    readSource: () => null,
    referencesOf: () => [],
    ...overrides,
  };
}

const modified = (path: string): ChangedFile => ({ path, status: 'M' });

describe('sourceStem', () => {
  it.each([
    ['lib/a/b.ts', 'lib/a/b'],
    ['app/x/page.tsx', 'app/x/page'],
  ])('strips the extension from %s', (path, expected) => {
    expect(sourceStem(path)).toBe(expected);
  });

  it.each(['types/next.d.ts', 'README.md', 'scripts/x.sh', 'app/globals.css'])(
    'returns null for %s',
    (path) => {
      expect(sourceStem(path)).toBeNull();
    }
  );
});

describe('mirrorCandidates', () => {
  it('keeps the .tsx suffix instead of looking for `page.tsx.test.ts`', () => {
    // The `${f%.ts}` bug, pinned. `%.ts` strips a suffix only when the string
    // ENDS with it, so `page.tsx` comes back unchanged and every candidate is
    // unreachable — a silent pass on every component and page a branch touches.
    const candidates = mirrorCandidates(sourceStem('app/admin/page.tsx') as string);
    expect(candidates).toContain('tests/unit/app/admin/page.test.tsx');
    expect(candidates.some((candidate) => candidate.includes('.tsx.test.'))).toBe(false);
  });

  it('offers both test roots and both suffixes', () => {
    expect(mirrorCandidates('lib/a/b')).toEqual([
      'tests/unit/lib/a/b.test.ts',
      'tests/unit/lib/a/b.test.tsx',
      'tests/integration/lib/a/b.test.ts',
      'tests/integration/lib/a/b.test.tsx',
    ]);
  });

  it('offers the `app/`-stripped form, which is where route tests live', () => {
    // `tests/integration/api/v1/users/route.test.ts` — no `app/` segment.
    expect(mirrorCandidates('app/api/v1/users/route')).toContain(
      'tests/integration/api/v1/users/route.test.ts'
    );
  });

  it('does not invent an `app/`-stripped form for a non-app path', () => {
    expect(mirrorCandidates('lib/app/env')).toEqual([
      'tests/unit/lib/app/env.test.ts',
      'tests/unit/lib/app/env.test.tsx',
      'tests/integration/lib/app/env.test.ts',
      'tests/integration/lib/app/env.test.tsx',
    ]);
  });
});

describe('collapsedDynamicCandidates', () => {
  it('drops `[id]` so a route can be tested from its collection sibling', () => {
    expect(collapsedDynamicCandidates('app/api/v1/foo/[id]/route')).toContain(
      'tests/unit/app/api/v1/foo/route.test.ts'
    );
  });

  it('returns nothing when there is no dynamic segment', () => {
    // Otherwise it would re-offer the mirror set under a second name and the
    // report would claim a route was found by a rule that never applied.
    expect(collapsedDynamicCandidates('lib/a/b')).toEqual([]);
  });
});

describe('aspectTestsFor', () => {
  const tests = [
    'tests/unit/lib/auth/config-signup-mode.test.ts',
    'tests/unit/lib/auth/config.database.test.ts',
    'tests/unit/lib/auth/configuration.test.ts',
    'tests/unit/lib/auth/guards.test.ts',
  ];

  it('matches `-` and `.` separated aspects of the same module', () => {
    expect(aspectTestsFor('lib/auth/config', tests, () => false)).toEqual([
      'tests/unit/lib/auth/config-signup-mode.test.ts',
      'tests/unit/lib/auth/config.database.test.ts',
    ]);
  });

  it('does not claim a longer module name that merely starts the same', () => {
    // `configuration.test.ts` belongs to `configuration.ts`. Without the
    // separator requirement a prefix match hands it to `config.ts`.
    expect(aspectTestsFor('lib/auth/config', tests, () => false)).not.toContain(
      'tests/unit/lib/auth/configuration.test.ts'
    );
  });

  it('does not claim a kebab-cased sibling that has its own source', () => {
    // `rate-limit-policy.test.ts` is `rate-limit-policy.ts`'s mirror test.
    // Crediting it to `rate-limit.ts` would mark a real gap as covered.
    const sources = new Set(['lib/security/rate-limit-policy.ts']);
    expect(
      aspectTestsFor(
        'lib/security/rate-limit',
        ['tests/unit/lib/security/rate-limit-policy.test.ts'],
        (path) => sources.has(path)
      )
    ).toEqual([]);
  });

  it('does not claim a sibling whose source is a directory barrel', () => {
    // `rate-limit-stores/` is a folder with an `index.ts`, not a flat file. The
    // first version of the guard checked `${own}.ts` only, so this one slipped
    // through while the flat-file case was correctly rejected — same
    // collision, one shape further out.
    const sources = new Set(['lib/security/rate-limit-stores/index.ts']);
    expect(
      aspectTestsFor(
        'lib/security/rate-limit',
        ['tests/unit/lib/security/rate-limit-stores.test.ts'],
        (path) => sources.has(path)
      )
    ).toEqual([]);
  });

  it('still matches when no such sibling source exists', () => {
    // Same input, one fact changed — proving the previous case turns on the
    // sibling's existence and not on the pattern.
    expect(
      aspectTestsFor(
        'lib/security/rate-limit',
        ['tests/unit/lib/security/rate-limit-policy.test.ts'],
        () => false
      )
    ).toEqual(['tests/unit/lib/security/rate-limit-policy.test.ts']);
  });
});

describe('pathExemption', () => {
  it.each([
    ['tests/unit/lib/a.test.ts', 'is a test'],
    ['types/next-auth.d.ts', 'type declarations only'],
    ['next.config.ts', 'root-level tool config'],
    ['app/(public)/layout.tsx', 'App Router boundary file'],
    ['app/error.tsx', 'App Router boundary file'],
  ])('exempts %s', (path, reason) => {
    expect(pathExemption(path)).toBe(reason);
  });

  it.each([
    'lib/security/rate-limit.ts',
    'app/admin/page.tsx',
    // Coverage excludes all four of these; 4f deliberately does not.
    'types/mcp.ts',
    'prisma/seeds/002-feature-flags.ts',
    'emails/welcome.tsx',
    'lib/env.ts',
    // A nested config module is application code, not a tool config.
    'lib/orchestration/knowledge/chunker.config.ts',
  ])('does not exempt %s', (path) => {
    expect(pathExemption(path)).toBeNull();
  });
});

describe('contentExemption', () => {
  it('exempts a barrel that only re-exports', () => {
    const source = `export { a } from '@/lib/a';\nexport type { B } from '@/lib/b';\n`;
    expect(contentExemption('lib/index.ts', source)).toBe('barrel — re-exports only');
  });

  it('does not exempt an index file that carries its own code', () => {
    // 14 index files in this repo are this shape. Exempting by filename — the
    // obvious rule — hides all of them, 9 of which have no mirrored test.
    const source = `export { a } from '@/lib/a';\nexport const REGISTRY = { a };\n`;
    expect(contentExemption('lib/index.ts', source)).toBeNull();
  });

  it('exempts a module that declares no runtime value', () => {
    const source = `import type { X } from '@/types';\nexport interface Y { x: X }\nexport type Z = Y;\n`;
    expect(contentExemption('lib/a/types.ts', source)).toBe('declares no runtime value');
  });

  it.each([
    ['a value export', `export type A = string;\nexport const DEFAULTS: A[] = [];\n`],
    [
      'a value import used at runtime',
      `import { Shield } from 'lucide-react';\nexport const I = Shield;\n`,
    ],
    ['a bare side-effect statement', `import '@/lib/polyfill';\nregisterEverything();\n`],
  ])('does not exempt a module with %s', (_label, source) => {
    expect(contentExemption('lib/a/thing.ts', source)).toBeNull();
  });

  it('does not exempt a module of bare side-effect imports', () => {
    // `lib/orchestration/engine/executors/index.ts` is 19 of these and nothing
    // else — each one runs `registerStepType()` on import. Treating every
    // ImportDeclaration as emitting nothing exempted the whole registration
    // barrel, in the direction that hides work.
    const source = `import '@/lib/a';\nimport '@/lib/b';\n`;
    expect(contentExemption('lib/registry/index.ts', source)).toBeNull();
  });

  it('still exempts a module whose imports are all bindings it only types with', () => {
    // The distinction is the import CLAUSE: `import type {X}` and `import {X}`
    // bring a name in, a bare specifier runs a module.
    const source = `import type { X } from '@/types';\nexport interface Y {\n  x: X;\n}\n`;
    expect(contentExemption('lib/a/types.ts', source)).toBe('declares no runtime value');
  });

  it('fails closed on a file it cannot read', () => {
    // `null` means "could not look". Treating that as an exemption would let an
    // unreadable file leave the report entirely, which is the failure this
    // whole check exists to stop.
    expect(contentExemption('lib/a/thing.ts', null)).toBeNull();
  });

  it('fails closed on an empty file', () => {
    expect(contentExemption('lib/a/thing.ts', '')).toBeNull();
  });
});

describe('reexportingBarrelSpecifier', () => {
  const barrel = 'lib/widgets/index.ts';

  it('finds the directory specifier when the barrel imports the module', () => {
    // The shape that actually occurs: the barrel imports siblings and
    // aggregates them into one exported value.
    const source = `import { A } from '@/lib/widgets/alpha';\nexport const ALL = [A];\n`;
    expect(
      reexportingBarrelSpecifier('lib/widgets/alpha', (path) => (path === barrel ? source : null))
    ).toBe('@/lib/widgets');
  });

  it('finds it for an `export … from` barrel too', () => {
    const source = `export { A } from '@/lib/widgets/alpha';\n`;
    expect(
      reexportingBarrelSpecifier('lib/widgets/alpha', (path) => (path === barrel ? source : null))
    ).toBe('@/lib/widgets');
  });

  it('returns null when the barrel does not name this module', () => {
    // Otherwise one tested sibling would carry the whole folder.
    const source = `export { B } from '@/lib/widgets/beta';\n`;
    expect(
      reexportingBarrelSpecifier('lib/widgets/alpha', (path) => (path === barrel ? source : null))
    ).toBeNull();
  });

  it('returns null when there is no barrel at all', () => {
    expect(reexportingBarrelSpecifier('lib/widgets/alpha', () => null)).toBeNull();
  });
});

describe('importSpecifiers', () => {
  it('adds the directory form for an index module', () => {
    expect(importSpecifiers('lib/security/index')).toEqual([
      '@/lib/security/index',
      '@/lib/security',
    ]);
  });

  it('offers only the module path otherwise', () => {
    expect(importSpecifiers('lib/security/sanitize')).toEqual(['@/lib/security/sanitize']);
  });
});

describe('classifyOne', () => {
  it('reports a file with no test anywhere', () => {
    const verdict = classifyOne(modified('lib/a/thing.ts'), context());
    expect(verdict.outcome.kind).toBe('missing');
  });

  it('prefers the mirror over an aspect sibling, and needs no corroboration for it', () => {
    // A test at the mirrored path is about this module by construction, so it
    // is the one route that is not required to name it.
    const verdict = classifyOne(
      modified('lib/a/thing.ts'),
      context({
        testFiles: ['tests/unit/lib/a/thing.test.ts', 'tests/unit/lib/a/thing-extra.test.ts'],
      })
    );
    expect(verdict.outcome).toEqual({
      kind: 'covered',
      testPath: 'tests/unit/lib/a/thing.test.ts',
      via: 'mirror',
    });
  });

  it('does not credit a collapsed-parent test that never names the module', () => {
    // The third instance of one class, and the reason it is now a rule rather
    // than a third guard: `collapsedDynamicCandidates` had no corroboration at
    // all, so 8 dynamic routes in this repo were credited to a collection
    // sibling's mirror test that does not import them.
    const verdict = classifyOne(
      modified('app/api/v1/foo/[id]/route.ts'),
      context({ testFiles: ['tests/unit/app/api/v1/foo/route.test.ts'] })
    );
    expect(verdict.outcome.kind).toBe('missing');
  });

  it('credits the collapsed-parent test when it does name the module', () => {
    // Same input, one fact changed — so the case above turns on corroboration
    // and not on the path arithmetic.
    const verdict = classifyOne(
      modified('app/api/v1/foo/[id]/route.ts'),
      context({
        testFiles: ['tests/unit/app/api/v1/foo/route.test.ts'],
        referencesOf: () => ['tests/unit/app/api/v1/foo/route.test.ts'],
      })
    );
    expect(verdict.outcome).toEqual({
      kind: 'covered',
      testPath: 'tests/unit/app/api/v1/foo/route.test.ts',
      via: 'collapsed-dynamic-segment',
    });
  });

  it('demotes an uncorroborated aspect sibling to referenced, not covered', () => {
    // It falls through rather than disappearing: another test names the module,
    // so `referenced` is the honest tier for it.
    const verdict = classifyOne(
      modified('lib/a/thing.ts'),
      context({
        testFiles: ['tests/unit/lib/a/thing-extra.test.ts'],
        referencesOf: () => ['tests/unit/lib/b/elsewhere.test.ts'],
      })
    );
    expect(verdict.outcome).toEqual({
      kind: 'referenced',
      referencedBy: ['tests/unit/lib/b/elsewhere.test.ts'],
    });
  });

  it('separates "a test names it" from "a test covers it"', () => {
    // The distinction the three-way verdict exists for: 240 files in this repo
    // are in this state, and calling them all clean or all missing is wrong in
    // opposite directions.
    const verdict = classifyOne(
      modified('lib/a/thing.ts'),
      context({ referencesOf: () => ['tests/unit/lib/b/other.test.ts'] })
    );
    expect(verdict.outcome).toEqual({
      kind: 'referenced',
      referencedBy: ['tests/unit/lib/b/other.test.ts'],
    });
  });

  it('exempts before it looks for a test', () => {
    // A test file must never be asked for a test of its own — and the reference
    // finder must not be consulted for one either.
    const verdict = classifyOne(modified('tests/unit/lib/a/thing.test.ts'), context());
    expect(verdict.outcome).toEqual({ kind: 'exempt', reason: 'is a test' });
  });

  it('applies the content exemption to a real barrel', () => {
    const verdict = classifyOne(
      modified('lib/a/index.ts'),
      context({ readSource: () => `export { x } from '@/lib/a/x';\n` })
    );
    expect(verdict.outcome).toEqual({ kind: 'exempt', reason: 'barrel — re-exports only' });
  });

  it('names where a missing file’s test should live', () => {
    const verdict = classifyOne(modified('app/admin/thing.tsx'), context());
    expect(verdict.outcome.kind === 'missing' && verdict.outcome.expected[0]).toBe(
      'tests/unit/app/admin/thing.test.tsx'
    );
  });
});

describe('selfTestFailure', () => {
  it('passes against the real classifier', () => {
    expect(selfTestFailure()).toBeNull();
  });

  it('catches a classifier that reports everything clean', () => {
    // The failure #641 is about: a scan that cannot report. If the sentinel
    // could not detect this, it would be decoration.
    const alwaysClean = (file: ChangedFile): Verdict => ({
      path: file.path,
      status: file.status,
      outcome: { kind: 'covered', testPath: 'tests/unit/whatever.test.ts', via: 'mirror' },
    });
    expect(selfTestFailure(alwaysClean)).toMatch(/never-tested\.ts: expected `missing`/);
  });

  it('catches a classifier that reports everything as a finding', () => {
    const alwaysMissing = (file: ChangedFile): Verdict => ({
      path: file.path,
      status: file.status,
      outcome: { kind: 'missing', expected: [] },
    });
    expect(selfTestFailure(alwaysMissing)).toMatch(/expected `covered`, got `missing`/);
  });
});

describe('the deliberate differences from vitest coverage exclusions', () => {
  /**
   * Trees that hold no source to test: vendored packages and build output.
   * Not 4f's business, and not a decision anyone needs to record.
   */
  const BUILD_OUTPUT = ['node_modules/', '.next/', 'coverage/', 'dist'];

  /**
   * A representative path for a coverage glob. Throws on a shape it does not
   * recognise, so a new KIND of pattern also forces a decision instead of
   * quietly producing a path that happens to be exempt.
   */
  function samplePathFor(pattern: string): string {
    if (pattern.endsWith('/')) return `${pattern}sample.ts`;
    const concrete = pattern
      // A literal path may be glob-escaped in the config — `app/(public)/…` is
      // extglob syntax, so the parens have to be escaped there or the pattern
      // matches nothing. Undo that first, or the sample path carries the
      // backslashes and matches no exemption rule.
      .replace(/\\+(.)/g, '$1')
      .replace(/\*\*\//g, 'sample/')
      .replace(/\/\*\*$/, '/sample.ts')
      .replace(/\{[^}]*\}/, 'ts')
      .replace(/\*/g, 'sample');
    if (concrete.includes('*') || concrete.includes('{')) {
      throw new Error(`Unrecognised coverage-exclude shape: ${pattern}`);
    }
    return concrete;
  }

  /** `coverage.exclude`'s string entries, read from the config itself. */
  function coverageExclusions(): string[] {
    const config = readFileSync('vitest.config.ts', 'utf8');
    const start = config.indexOf('coverage: {');
    expect(start).toBeGreaterThan(-1);
    const block = config.slice(config.indexOf('exclude: [', start));
    const body = block.slice('exclude: ['.length, block.indexOf(']'));
    return Array.from(body.matchAll(/'([^']+)'/g)).map((match) => match[1]);
  }

  it('reads the real exclusion list', () => {
    // A parse that silently returns [] would make every assertion below vacuous.
    const exclusions = coverageExclusions();
    expect(exclusions.length).toBeGreaterThan(10);
    expect(exclusions).toContain('tests/');
  });

  it.each(NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION.map((entry) => entry.pattern))(
    'still excludes %s from coverage, so the difference is real',
    (pattern) => {
      // A "deliberate difference" from a rule that no longer exists is a
      // fiction, and the reason attached to it stops being checkable.
      expect(coverageExclusions()).toContain(pattern);
    }
  );

  it.each(NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION)(
    'does not path-exempt files matching $pattern',
    ({ pattern }) => {
      expect(pathExemption(samplePathFor(pattern))).toBeNull();
    }
  );

  it('accounts for every coverage exclusion, so a new one forces a decision', () => {
    // The direction that can actually drift, and the one the first version of
    // this block did not test: it walked the four known differences and never
    // walked the config. Adding `components/ui/` to `coverage.exclude`
    // upstream would have passed every assertion here while silently widening
    // what step 3 ignores and step 4f does not.
    const declared = new Set(NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION.map((e) => e.pattern));
    const unaccounted = coverageExclusions().filter(
      (pattern) =>
        !declared.has(pattern) &&
        !BUILD_OUTPUT.includes(pattern) &&
        pathExemption(samplePathFor(pattern)) === null
    );
    expect(
      unaccounted,
      'A coverage exclusion this check neither honours nor deliberately ignores. ' +
        'Add it to PATH_EXEMPTIONS, to NOT_EXEMPT_DESPITE_COVERAGE_EXCLUSION with a ' +
        'reason, or to BUILD_OUTPUT in this test.'
    ).toEqual([]);
  });
});
