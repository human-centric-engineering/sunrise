/**
 * Whole-tree guard: every `@see` path in source and tests is repo-relative.
 *
 * `@see lib/api/client.ts` resolves for every contributor, in CI, and in every
 * fork. An absolute path (a home directory on one maintainer's machine, or a
 * path with a leading `/`) resolves for nobody else. 57 of those once sat in
 * `tests/unit/**`, three of them pointing at a sibling checkout rather than
 * this repo, and every fork inherited them (#749).
 *
 * The matcher flags a `@see` whose target starts with `/`, `~`, or a Windows
 * drive letter. A repo-relative path, a URL (`https://…`), or a symbol name
 * (`{@link foo}`, `@see foo()`) does not start with any of those, so none of
 * them match. If you need to point at a route, name its file
 * (`app/api/v1/…/route.ts`), not its URL path.
 *
 * Registered in ALWAYS_RUN_TESTS (`scripts/ci/scoped-tests.ts`): a new header
 * comment in some far-off file is exactly the change whose import graph never
 * reaches this test.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** `@see` followed by an absolute or home-relative target. */
const ABSOLUTE_SEE = /@see\s+(?:\/|~|[A-Za-z]:[\\/])/;

/** Top-level directories that hold code a fork inherits. */
const ROOTS = ['app', 'components', 'emails', 'lib', 'prisma', 'scripts', 'tests', 'types'];

const EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const REPO_ROOT = process.cwd();

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

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
    expect(findAbsoluteSeeTags(` * ${at} /Users/someone/Dev/sunrise/lib/api/client.ts`)).toEqual([
      1,
    ]);
    expect(findAbsoluteSeeTags(` * ${at} /home/someone/sunrise/lib/api/client.ts`)).toEqual([1]);
    expect(findAbsoluteSeeTags(` * ${at} /components/auth/user-button.tsx`)).toEqual([1]);
    expect(findAbsoluteSeeTags(` * ${at} ~/code/sunrise/lib/x.ts`)).toEqual([1]);
    expect(findAbsoluteSeeTags(` * ${at} C:\\Users\\someone\\lib\\x.ts`)).toEqual([1]);

    expect(findAbsoluteSeeTags(` * ${at} lib/api/client.ts`)).toEqual([]);
    expect(findAbsoluteSeeTags(` * ${at} .context/testing/scoped-runs.md`)).toEqual([]);
    expect(findAbsoluteSeeTags(` * ${at} https://example.com/docs`)).toEqual([]);
  });

  it('scans a non-empty tree', () => {
    for (const root of ROOTS) {
      expect(statSync(path.join(REPO_ROOT, root)).isDirectory(), root).toBe(true);
    }
    const files = ROOTS.flatMap((root) => listFiles(path.join(REPO_ROOT, root)));
    // A scan that read nothing would pass; make sure it read the tree.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('has no @see pointing at an absolute path', () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of listFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        for (const line of findAbsoluteSeeTags(readFileSync(file, 'utf8'))) {
          violations.push(`${rel}:${line}`);
        }
      }
    }
    expect(
      violations,
      'Write @see targets repo-relative (e.g. `lib/api/client.ts`), not as an absolute path'
    ).toEqual([]);
  });
});
