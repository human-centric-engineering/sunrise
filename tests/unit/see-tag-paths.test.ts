/**
 * Whole-tree guard: no `@see` in source or tests names an absolute path.
 *
 * `@see lib/api/client.ts` resolves for every contributor, in CI, and in every
 * fork. An absolute path (a home directory on one maintainer's machine, or a
 * path with a leading `/`) resolves for nobody else. 57 of those once sat in
 * `tests/unit/**`, three of them pointing at a sibling checkout rather than
 * this repo, and every fork inherited them (#749).
 *
 * The matcher flags a `@see` whose target starts with `/`, `~`, or a Windows
 * drive letter, including when it is wrapped in backticks or `{@link…}`, or
 * written as a `file:` or `vscode://file` URL. `~` counts: it is outside the
 * repo, so it cannot be what a test or module header points at. A
 * repo-relative path, an `https://` URL, or a symbol name does not match.
 * Paths relative to the file (`./`, `../`) are out of scope here, and so are
 * absolute paths in comments that are not `@see` tags.
 * If you need to point at a route, name its file (`app/api/v1/…/route.ts`),
 * not its URL path.
 *
 * Registered in ALWAYS_RUN_TESTS (`scripts/ci/scoped-tests.ts`): a new header
 * comment in some far-off file is exactly the change whose import graph never
 * reaches this test.
 */

import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `@see` followed by an absolute or home-relative target. */
const ABSOLUTE_SEE =
  /@see\s+`?(?:\{@link\w*\s+)?`?(?:file:\/{0,2}|vscode:\/\/file)?(?:\/|~|[A-Za-z]:[\\/])/;

const ROOT = process.cwd();

/** Source roots a fork inherits. A root a fork has deleted matches nothing. */
const ROOTS = [
  'app',
  'components',
  'emails',
  'hooks',
  'lib',
  'prisma',
  'scripts',
  'tests',
  'types',
];

/**
 * The source roots plus the tool configs at the repo root. Files only: a route
 * folder can carry a file extension (`app/api/v1/embed/widget.js/`).
 */
const FILES = globSync(
  [`{${ROOTS.join(',')}}/**/*.{ts,tsx,js,jsx,mjs,cjs,prisma}`, '*.{ts,tsx,js,jsx,mjs,cjs}'],
  { cwd: ROOT, withFileTypes: true, exclude: (entry) => entry.name === 'node_modules' }
)
  .filter((entry) => entry.isFile())
  .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort();

function findAbsoluteSeeTags(source: string): number[] {
  const lines: number[] = [];
  if (!source.includes('@see')) return lines;
  source.split('\n').forEach((line, i) => {
    if (ABSOLUTE_SEE.test(line)) lines.push(i + 1);
  });
  return lines;
}

describe('@see paths', () => {
  it('flags absolute and home-relative targets, and leaves repo-relative ones alone', () => {
    // Built by concatenation so this file does not trip its own scan.
    const at = '@' + 'see';
    const flagged = [
      `/Users/someone/Dev/sunrise/lib/api/client.ts`,
      `/home/someone/sunrise/lib/api/client.ts`,
      `/components/auth/user-button.tsx`,
      `~/code/sunrise/lib/x.ts`,
      `C:\\Users\\someone\\lib\\x.ts`,
      `{@link /Users/someone/sunrise/lib/x.ts}`,
      `file:///Users/someone/sunrise/lib/x.ts`,
      `file:/Users/someone/sunrise/lib/x.ts`,
      `vscode://file/Users/someone/sunrise/lib/x.ts`,
      '`/Users/someone/sunrise/lib/x.ts`',
      `{@linkcode /Users/someone/sunrise/lib/x.ts}`,
      `{@linkplain /Users/someone/sunrise/lib/x.ts}`,
    ];
    for (const target of flagged) {
      expect(findAbsoluteSeeTags(` * ${at} ${target}`), target).toEqual([1]);
    }
    expect(findAbsoluteSeeTags(`/// ${at} /home/someone/lib/x.ts`)).toEqual([1]);

    const allowed = [
      'lib/api/client.ts',
      '.context/testing/scoped-runs.md',
      'https://example.com/docs',
      '{@link findRateLimitRule}',
      '`.context/auth/authorization.md`',
    ];
    for (const target of allowed) {
      expect(findAbsoluteSeeTags(` * ${at} ${target}`), target).toEqual([]);
    }
  });

  it('scans a non-empty tree', () => {
    // A scan that read nothing would pass; make sure it read the tree.
    expect(FILES.length).toBeGreaterThan(1000);
    // Every root that exists on disk must contribute, so a pattern bug cannot
    // quietly drop a whole directory from the scan.
    for (const root of ROOTS.filter((r) => existsSync(resolve(ROOT, r)))) {
      expect(
        FILES.some((f) => f.startsWith(`${root}/`)),
        root
      ).toBe(true);
    }
    expect(FILES).toContain('proxy.ts');
    expect(FILES.some((f) => f.endsWith('.prisma'))).toBe(true);
  });

  it('has no @see pointing at an absolute path', () => {
    const violations = FILES.flatMap((file) =>
      findAbsoluteSeeTags(readFileSync(resolve(ROOT, file), 'utf8')).map(
        (line) => `${file}:${line}`
      )
    );
    expect(
      violations,
      'Write @see targets repo-relative (e.g. `lib/api/client.ts`), not as an absolute path'
    ).toEqual([]);
  });
});
