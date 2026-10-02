/**
 * Test `@see` references are repo-relative, never an absolute path on someone's machine.
 *
 * Fifty-seven test headers once pointed their `see` tag at an absolute `/Users/<name>/...` path (#749):
 * the location of the file under test on one maintainer's laptop. It resolves for no one else,
 * and because `tests/` is platform-owned it merged straight through to every fork — where it
 * gives editor "go to definition" nothing, and shows up as upstream noise when a fork greps
 * its own tree for stale local paths. Three of the fifty-seven even named a sibling checkout
 * rather than this repo.
 *
 * Every other `@see` in `tests/` is repo-relative (`lib/api/client.ts`,
 * `.context/auth/oauth.md`); an absolute one is always a paste from an editor's "copy path".
 *
 * This test reads the tree rather than any module it imports, so no import chain connects it
 * to the files it checks — which is why it is listed in `ALWAYS_RUN_TESTS`
 * (`scripts/ci/scoped-tests.ts`) and runs on every scoped run.
 *
 * @see .context/testing/scoped-runs.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'tinyglobby';

// A `@see` whose target starts at a filesystem root: POSIX `/…`, home `~/…`, or a Windows
// drive `C:\…` / `C:/…`. `@see https://…` and `@see lib/…` do not match.
const ABSOLUTE_SEE = /@see\s+(?:\/|~\/|[A-Za-z]:[\\/])\S*/;

interface Occurrence {
  line: number;
  text: string;
}

function absoluteSeesIn(source: string): Occurrence[] {
  const found: Occurrence[] = [];
  source.split('\n').forEach((text, index) => {
    if (ABSOLUTE_SEE.test(text)) found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

const ROOT = process.cwd();
const TEST_FILES = globSync(['tests/**/*.{ts,tsx}'], {
  cwd: ROOT,
  ignore: ['**/node_modules/**'],
}).sort();

describe('the scan itself', () => {
  it('finds the test tree, or every assertion below is vacuous', () => {
    // A glob that matches nothing reports a clean tree.
    expect(TEST_FILES.length).toBeGreaterThan(900);
  });

  it('flags absolute paths and passes repo-relative ones', () => {
    // Proves the detector can report before any clean result is trusted. The sentinels are
    // assembled at runtime so this file does not contain a literal offender itself.
    const see = '@' + 'see';
    const bad = [
      ` * ${see} /Users/someone/app/lib/api/client.ts`,
      ` * ${see} /home/runner/work/app/lib/api/client.ts`,
      ` * ${see} ~/dev/app/lib/api/client.ts`,
      ` * ${see} C:\\dev\\app\\lib\\api\\client.ts`,
      ` * ${see} C:/dev/app/lib/api/client.ts`,
    ];
    const good = [
      ` * ${see} lib/api/client.ts`,
      ` * ${see} .context/testing/scoped-runs.md § For forks`,
      ` * ${see} https://example.com/docs`,
    ];
    expect(absoluteSeesIn(bad.join('\n')).map((o) => o.line)).toEqual([1, 2, 3, 4, 5]);
    expect(absoluteSeesIn(good.join('\n'))).toEqual([]);
  });
});

describe('test @see references', () => {
  it('are repo-relative, not absolute paths on a contributor machine', () => {
    const offenders = TEST_FILES.flatMap((path) =>
      absoluteSeesIn(readFileSync(resolve(ROOT, path), 'utf8')).map(
        (o) => `${path}:${o.line}  ${o.text}`
      )
    );

    expect(
      offenders,
      'A @see pointing at an absolute path resolves for nobody but its author and ships to ' +
        'every fork. Use the repo-relative path of the file under test, e.g. ' +
        '`@see lib/api/client.ts`.'
    ).toEqual([]);
  });
});
