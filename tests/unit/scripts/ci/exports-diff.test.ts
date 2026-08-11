/**
 * Tests for the barrel export rules.
 *
 * The headline case is `the export step 5d missed`, which reproduces #506's
 * addition of `normalizeRootRelativePath` to `@/lib/security` — public surface
 * that `/pre-pr`'s path list did not notice (#552).
 *
 * @see scripts/ci/exports-diff.ts
 */

import { describe, it, expect } from 'vitest';

import { diffExports, readBarrelExports, type BarrelExports } from '@/scripts/ci/exports-diff';

/** No sibling is resolvable — the default for tests that use no `export *`. */
const noSiblings = (): null => null;

/** Serves sibling sources by specifier, all pretending to sit in the same dir. */
function symbolsOf(source: string, siblings: Record<string, string> = {}): string[] {
  return readBarrelExports(source, (specifier) => {
    const text = siblings[specifier];
    return text === undefined ? null : { text, dir: '' };
  }).symbols;
}

describe('readBarrelExports', () => {
  it('reads named re-exports', () => {
    expect(symbolsOf(`export { escapeHtml, sanitizeUrl } from './sanitize';`)).toEqual([
      'escapeHtml',
      'sanitizeUrl',
    ]);
  });

  it('reads the renamed name, which is what a fork imports', () => {
    expect(symbolsOf(`export { internalName as publicName } from './x';`)).toEqual(['publicName']);
  });

  it('reads type-only re-exports', () => {
    // A fork importing a type is as coupled as one importing a value.
    expect(symbolsOf(`export type { Options } from './types';`)).toEqual(['Options']);
  });

  it.each([
    ['const', `export const answer = 42;`, 'answer'],
    ['function', `export function doThing() {}`, 'doThing'],
    ['class', `export class Thing {}`, 'Thing'],
    ['interface', `export interface Shape { a: string }`, 'Shape'],
    ['type alias', `export type Alias = string;`, 'Alias'],
    ['enum', `export enum Colour { Red }`, 'Colour'],
  ])('reads a direct %s export', (_kind, source, expected) => {
    expect(symbolsOf(source)).toEqual([expected]);
  });

  it('ignores declarations that are not exported', () => {
    expect(symbolsOf(`const hidden = 1;\nexport const shown = 2;`)).toEqual(['shown']);
  });

  it('reads every name in a multi-declaration export', () => {
    expect(symbolsOf(`export const a = 1, b = 2;`)).toEqual(['a', 'b']);
  });

  describe('export *', () => {
    it('follows the star and reports what it actually re-exports', () => {
      // The reason this uses the compiler rather than a regex: the line names
      // no symbols, so a regex would report the barrel as exporting nothing
      // while a fork can import both of these.
      const symbols = symbolsOf(`export * from './inner';`, {
        './inner': `export const alpha = 1;\nexport function beta() {}`,
      });

      expect(symbols).toEqual(['alpha', 'beta']);
    });

    it('follows a star through a second level', () => {
      const symbols = symbolsOf(`export * from './a';`, {
        './a': `export * from './b';`,
        './b': `export const deep = 1;`,
      });

      expect(symbols).toEqual(['deep']);
    });

    it('follows an `@/` specifier, which is the only form this repo produces', () => {
      // CLAUDE.md mandates the alias and ESLint forbids relative paths, so all
      // six stars in `lib/` are `@/`. Resolution is the caller's job — see
      // `resolveSpecifier` — but the parser must hand the specifier over
      // unchanged rather than pre-filtering it.
      const seen: string[] = [];
      readBarrelExports(`export * from '@/lib/orchestration/llm/types';`, (specifier) => {
        seen.push(specifier);
        return { text: `export type LlmMessage = string;`, dir: '' };
      });

      expect(seen).toEqual(['@/lib/orchestration/llm/types']);
    });

    it('records a namespace re-export as the one symbol it is', () => {
      // `export * as costTracker from '…'` is a NamespaceExport: not a named
      // export, and not a bare star. It fell through both branches and was
      // recorded nowhere, so deleting one read as no change.
      expect(symbolsOf(`export * as costTracker from '@/lib/x';`)).toEqual(['costTracker']);
    });

    it('reports a star it could not follow rather than counting it as nothing', () => {
      // "no symbols" and "could not look" must not arrive as the same answer,
      // or an unreadable module reads as a surface that shrank to zero.
      const parsed = readBarrelExports(`export * from './missing';`, noSiblings);

      expect(parsed.symbols).toEqual([]);
      expect(parsed.unresolvedStars).toEqual(['./missing']);
    });

    it('terminates on a cycle between two barrels', () => {
      const siblings: Record<string, string> = {
        './a': `export * from './b';\nexport const fromA = 1;`,
        './b': `export * from './a';\nexport const fromB = 2;`,
      };

      const symbols = symbolsOf(`export * from './a';`, siblings);

      expect(symbols).toEqual(['fromA', 'fromB']);
    });

    it("merges the star with the barrel's own exports", () => {
      const symbols = symbolsOf(`export * from './inner';\nexport const own = 1;`, {
        './inner': `export const inherited = 2;`,
      });

      expect(symbols).toEqual(['inherited', 'own']);
    });
  });

  it('does not treat an import as an export', () => {
    expect(symbolsOf(`import { thing } from './x';\nexport const other = 1;`)).toEqual(['other']);
  });
});

describe('diffExports', () => {
  const barrel = (file: string, symbols: string[]): BarrelExports => ({
    file,
    symbols,
    unresolvedStars: [],
  });

  it('reports nothing when the surface is unchanged', () => {
    const before = [barrel('lib/security/index.ts', ['escapeHtml', 'sanitizeUrl'])];

    expect(
      diffExports(before, [barrel('lib/security/index.ts', ['escapeHtml', 'sanitizeUrl'])])
    ).toEqual([]);
  });

  describe('the export step 5d missed', () => {
    // #506 added `normalizeRootRelativePath` to `@/lib/security`. That file is
    // not on step 5d's path list, so the gate said nothing; the CHANGELOG
    // entry exists because a human judged it necessary.
    it('is reported', () => {
      const before = [barrel('lib/security/index.ts', ['escapeHtml', 'isRootRelativePath'])];
      const after = [
        barrel('lib/security/index.ts', [
          'escapeHtml',
          'isRootRelativePath',
          'normalizeRootRelativePath',
        ]),
      ];

      expect(diffExports(before, after)).toEqual([
        { file: 'lib/security/index.ts', added: ['normalizeRootRelativePath'], removed: [] },
      ]);
    });
  });

  it('reports a removal, which is breaking for anyone importing it', () => {
    const before = [barrel('lib/api/index.ts', ['successResponse', 'legacyResponse'])];
    const after = [barrel('lib/api/index.ts', ['successResponse'])];

    expect(diffExports(before, after)).toEqual([
      { file: 'lib/api/index.ts', added: [], removed: ['legacyResponse'] },
    ]);
  });

  it('reports a rename as both halves', () => {
    // Not a "change" — for a fork it is one import breaking and one appearing.
    const before = [barrel('lib/x/index.ts', ['oldName'])];
    const after = [barrel('lib/x/index.ts', ['newName'])];

    expect(diffExports(before, after)).toEqual([
      { file: 'lib/x/index.ts', added: ['newName'], removed: ['oldName'] },
    ]);
  });

  it('treats a brand-new barrel as entirely new surface', () => {
    expect(diffExports([], [barrel('lib/new/index.ts', ['a', 'b'])])).toEqual([
      { file: 'lib/new/index.ts', added: ['a', 'b'], removed: [] },
    ]);
  });

  it('treats a deleted barrel as entirely removed surface', () => {
    // Nothing in the head list mentions the file, so the head-side pass alone
    // would never see it.
    expect(diffExports([barrel('lib/gone/index.ts', ['a'])], [])).toEqual([
      { file: 'lib/gone/index.ts', added: [], removed: ['a'] },
    ]);
  });

  it('sorts by file so output is stable across runs', () => {
    const before = [barrel('lib/z/index.ts', []), barrel('lib/a/index.ts', [])];
    const after = [barrel('lib/z/index.ts', ['z']), barrel('lib/a/index.ts', ['a'])];

    expect(diffExports(before, after).map((change) => change.file)).toEqual([
      'lib/a/index.ts',
      'lib/z/index.ts',
    ]);
  });
});
