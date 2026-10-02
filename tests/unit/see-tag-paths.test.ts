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
 * drive letter, including when it is wrapped in `{@link …}` or written as a
 * `file://` URL. A repo-relative path, an `https://` URL, or a symbol name does
 * not match. Paths relative to the file (`./`, `../`) are out of scope here.
 * If you need to point at a route, name its file (`app/api/v1/…/route.ts`),
 * not its URL path.
 *
 * Registered in ALWAYS_RUN_TESTS (`scripts/ci/scoped-tests.ts`): a new header
 * comment in some far-off file is exactly the change whose import graph never
 * reaches this test.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'tinyglobby';
import { describe, expect, it } from 'vitest';

/** `@see` followed by an absolute or home-relative target. */
const ABSOLUTE_SEE = /@see\s+(?:\{@link\s+)?(?:file:\/\/)?(?:\/|~|[A-Za-z]:[\\/])/;

const ROOT = process.cwd();

/**
 * Code a fork inherits: the source roots plus the tool configs at the repo
 * root. A root a fork has deleted simply matches nothing.
 */
const FILES = globSync(
  [
    '{app,components,emails,hooks,lib,prisma,scripts,tests,types}/**/*.{ts,tsx,js,jsx,mjs,cjs,prisma}',
    '*.{ts,tsx,js,jsx,mjs,cjs}',
  ],
  { cwd: ROOT, ignore: ['**/node_modules/**'] }
).sort();

function findAbsoluteSeeTags(source: string): number[] {
  const lines: number[] = [];
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
    ];
    for (const target of allowed) {
      expect(findAbsoluteSeeTags(` * ${at} ${target}`), target).toEqual([]);
    }
  });

  it('scans a non-empty tree', () => {
    // A scan that read nothing would pass; make sure it read the tree.
    expect(FILES.length).toBeGreaterThan(1000);
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
