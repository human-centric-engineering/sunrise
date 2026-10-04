/**
 * Tests: `runAsCrossOrgCount` has one caller (§107 t-752). The whole checkout
 * is read — root files like `proxy.ts` too.
 *
 * The scope is the audited bypass, logged at debug instead of info because
 * the admin pages enter it on every load. That trade is only safe while every
 * entry is a read-only count that returns another org's rows as numbers,
 * which is what `lib/orchestration/admin/global-config-usage.ts` does. A new
 * caller anywhere else is a bypass nobody would see in the info log. If this
 * fails naming your file: count through that module, or use `runAsSystem`.
 *
 * Any mention of the name IN CODE counts — an import, a call, an alias, a
 * destructured `await import(…)`, a stored reference — found with the
 * TypeScript scanner, so a comment or a string that names it does not. So
 * does `export * from '@/lib/tenancy/context'`, which would hand it to every
 * importer of the barrel without naming it.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS`, because a new caller is a file
 * no import chain connects to this test.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const NAME = 'runAsCrossOrgCount';

const ALLOWED = new Set([
  'lib/tenancy/context.ts', // the definition
  'lib/orchestration/admin/global-config-usage.ts', // the one caller
]);

/** Every source file in the checkout — root files like `proxy.ts` included — but tests. */
function sourceFiles(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
    .split('\n')
    .filter(
      (p) =>
        /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(p) &&
        !p.startsWith('tests/') &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    );
}

const STAR_REEXPORT = /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]@\/lib\/tenancy\/context['"]/;

/** Does this source use the scope in code, or re-export everything beside it? */
function uses(path: string, source: string): boolean {
  if (STAR_REEXPORT.test(source)) return true;
  if (!source.includes(NAME)) return false;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    /\.[jt]sx$/.test(path) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier && scanner.getTokenText() === NAME) return true;
  }
  return false;
}

function callersIn(
  files: readonly string[],
  text = (p: string) => readFileSync(p, 'utf8')
): string[] {
  return files.filter((p) => !ALLOWED.has(p) && uses(p, text(p)));
}

describe('runAsCrossOrgCount', () => {
  it('is entered only by the global-config usage module', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining([...ALLOWED, 'proxy.ts']));
    expect(callersIn(files)).toEqual([]);
    // The allowed files are found by the same check, so it can see a use.
    expect(ALLOWED.size).toBe(2);
    for (const p of ALLOWED) expect(uses(p, readFileSync(p, 'utf8'))).toBe(true);
  });

  const at = (source: string) => callersIn(['lib/tenancy/constants.ts'], () => source);

  it.each([
    ['a named import', "import { runAsCrossOrgCount } from '@/lib/tenancy/context';"],
    ['an aliased import', "import { runAsCrossOrgCount as count } from '@/lib/tenancy/context';"],
    ['a call', "await runAsCrossOrgCount('r', fn);"],
    ['a re-export', "export { runAsCrossOrgCount } from '@/lib/tenancy/context';"],
    [
      'a destructured dynamic import',
      "const { runAsCrossOrgCount: count } = await import('@/lib/tenancy/context');",
    ],
    ['a stored reference', 'const enter = context.runAsCrossOrgCount;'],
    ['a star re-export of the context module', "export * from '@/lib/tenancy/context';"],
    ['a namespaced star re-export', "export * as ctx from '@/lib/tenancy/context';"],
  ])('names %s', (_label, source) => {
    expect(at(source)).toEqual(['lib/tenancy/constants.ts']);
  });

  it.each([
    ['a comment', '// see `runAsCrossOrgCount`, the debug bypass'],
    ['a block comment', '/** `runAsCrossOrgCount` is confined */'],
    ['a string', "const reason = 'greps for `runAsCrossOrgCount` in prose';"],
    ['a longer identifier', 'const runAsCrossOrgCountish = 1;'],
    ['a star re-export of another module', "export * from '@/lib/tenancy/constants';"],
  ])('ignores %s', (_label, source) => {
    expect(at(source)).toEqual([]);
  });
});
