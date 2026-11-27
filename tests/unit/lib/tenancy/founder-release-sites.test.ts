/**
 * Tests: `runAsFounderRelease` (t-1084) and `runAsFounderJoin` (t-1096) are
 * each called from one file. The whole checkout is read — root files like
 * `proxy.ts` too.
 *
 * `runAsFounderJoin` is the same trade for the batch that writes a founder's
 * own membership and removes their org's awaiting-founder mark, entered by
 * `writeNewUserMemberships()` in `lib/tenancy/membership.ts`. The cases below
 * read the release's name; the join's is checked by the same scan.
 *
 * The scope is the audited bypass, logged at debug instead of info because it
 * runs on every sign-in at `multi`. That trade is only safe while the one
 * thing inside is `releaseFoundedSignupOrgs()`'s single statement for one
 * user, entered by `completeFoundedSignupOrgs()` in `lib/tenancy/lifecycle.ts`.
 * A new caller anywhere else is a bypass nobody would see in the info log. If
 * this fails naming your file: use `runAsSystem`.
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

const NAME = 'runAsFounderRelease';

const ALLOWED = new Set([
  'lib/tenancy/context.ts', // the definition
  'lib/tenancy/lifecycle.ts', // the caller: completeFoundedSignupOrgs()
]);

const JOIN_NAME = 'runAsFounderJoin';

const JOIN_ALLOWED = new Set([
  'lib/tenancy/context.ts', // the definition
  'lib/tenancy/membership.ts', // the caller: writeNewUserMemberships()
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
function uses(path: string, source: string, name = NAME): boolean {
  if (STAR_REEXPORT.test(source)) return true;
  if (!source.includes(name)) return false;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    /\.[jt]sx$/.test(path) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier && scanner.getTokenText() === name) return true;
  }
  return false;
}

function callersIn(
  files: readonly string[],
  text = (p: string) => readFileSync(p, 'utf8')
): string[] {
  return files.filter((p) => !ALLOWED.has(p) && uses(p, text(p)));
}

describe('runAsFounderJoin', () => {
  it('is entered only by the founder’s membership write', () => {
    const files = sourceFiles();
    const callers = files.filter(
      (p) => !JOIN_ALLOWED.has(p) && uses(p, readFileSync(p, 'utf8'), JOIN_NAME)
    );
    // A star re-export of the context module is counted by both scans, and
    // the release's own allow-list does not cover it either.
    expect(callers).toEqual([]);
    for (const p of JOIN_ALLOWED) expect(uses(p, readFileSync(p, 'utf8'), JOIN_NAME)).toBe(true);
  });
});

describe('runAsFounderRelease', () => {
  it('is entered only by the founder release at sign-in', () => {
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
    ['a named import', "import { runAsFounderRelease } from '@/lib/tenancy/context';"],
    [
      'an aliased import',
      "import { runAsFounderRelease as release } from '@/lib/tenancy/context';",
    ],
    ['a call', 'await runAsFounderRelease(fn);'],
    ['a re-export', "export { runAsFounderRelease } from '@/lib/tenancy/context';"],
    [
      'a destructured dynamic import',
      "const { runAsFounderRelease: release } = await import('@/lib/tenancy/context');",
    ],
    ['a stored reference', 'const enter = context.runAsFounderRelease;'],
    ['a star re-export of the context module', "export * from '@/lib/tenancy/context';"],
    ['a namespaced star re-export', "export * as ctx from '@/lib/tenancy/context';"],
  ])('names %s', (_label, source) => {
    expect(at(source)).toEqual(['lib/tenancy/constants.ts']);
  });

  it.each([
    ['a comment', '// see `runAsFounderRelease`, the debug bypass'],
    ['a block comment', '/** `runAsFounderRelease` is confined */'],
    ['a string', "const reason = 'greps for `runAsFounderRelease` in prose';"],
    ['a longer identifier', 'const runAsFounderReleaseish = 1;'],
    ['a star re-export of another module', "export * from '@/lib/tenancy/constants';"],
  ])('ignores %s', (_label, source) => {
    expect(at(source)).toEqual([]);
  });
});
