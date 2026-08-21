/**
 * Every environment directive is a single value, on line 1.
 *
 * **Why this needs a check at all.** Vitest finds the directive with
 * `/@(?:vitest|jest)-environment\s+([\w-]+)\b/` applied to the whole file, not
 * to its header — so any occurrence anywhere wins, including one inside a
 * comment that is merely *talking about* the directive. That is not
 * hypothetical: it happened while writing `tests/unit/setup/`'s guard tests. A
 * comment explaining the docblock put the entire file on happy-dom, and the
 * only reason it surfaced was a deliberate `expect(typeof window).toBe(
 * 'undefined')` tripwire at the top of that file.
 *
 * **And one direction of getting it wrong is silent.** A file that should run
 * on node but picks up happy-dom still passes — happy-dom provides everything
 * node does and more — so it quietly rejoins the class of test this repo moved
 * off happy-dom to escape: under a DOM, `lib/env.ts` validates only the client
 * schema and every server variable reads as `undefined`. The other direction (a
 * DOM test landing on node) fails loudly with `document is not defined` and
 * needs no help.
 *
 * So: node-by-default needs no per-file guard, but the *directive* does.
 *
 * This test reads the tree rather than any module it imports, so no import
 * chain connects it to the files it checks — which is why it is listed in
 * `ALWAYS_RUN_TESTS` (`scripts/ci/scoped-tests.ts`) and runs on every scoped
 * run. See `.context/testing/environments.md`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'tinyglobby';

// Assembled at runtime so this file does not contain the literal directive.
//
// Not caution — experience. The first version of this file spelled it out in a
// `describe` title, vitest matched it, and the whole file tried to load an
// environment called `directives`. Do not write the token here in any form,
// including prose.
const DIRECTIVE = new RegExp(`@(?:vitest|jest)-${'environment'}\\s+([\\w-]+)\\b`);

interface Occurrence {
  line: number;
  value: string;
}

function directivesIn(source: string): Occurrence[] {
  const found: Occurrence[] = [];
  source.split('\n').forEach((text, index) => {
    const match = DIRECTIVE.exec(text);
    if (match) found.push({ line: index + 1, value: match[1] });
  });
  return found;
}

const ROOT = process.cwd();
const TEST_FILES = globSync(['tests/**/*.test.ts', 'tests/**/*.test.tsx'], {
  cwd: ROOT,
  ignore: ['**/node_modules/**'],
}).sort();

const withDirective = TEST_FILES.map((path) => ({
  path,
  occurrences: directivesIn(readFileSync(resolve(ROOT, path), 'utf8')),
})).filter((entry) => entry.occurrences.length > 0);

describe('the scan itself', () => {
  it('finds the test tree, or every assertion below is vacuous', () => {
    // A glob that matches nothing reports a clean tree. That is the shape this
    // repo keeps having to guard against, so it is asserted first.
    expect(TEST_FILES.length).toBeGreaterThan(900);
  });

  it('finds files carrying a directive', () => {
    expect(withDirective.length).toBeGreaterThan(100);
  });

  it('detects a directive that is not on line 1', () => {
    // Proves the detector can report before any clean result is trusted.
    const planted = ['// a header', '', '// see the @vitest-' + 'environment happy-dom docblock'];
    const found = directivesIn(planted.join('\n'));
    expect(found).toEqual([{ line: 3, value: 'happy-dom' }]);
  });
});

describe('environment directives', () => {
  it('appear only on line 1', () => {
    const misplaced = withDirective
      .filter((entry) => entry.occurrences[0].line !== 1)
      .map((entry) => `${entry.path}:${entry.occurrences[0].line}`);

    expect(
      misplaced,
      'A directive below line 1 still applies to the whole file — vitest scans the ' +
        'entire source, not just the header. If you are writing *about* the directive, ' +
        'do not spell it out; say "the environment docblock" instead.'
    ).toEqual([]);
  });

  it('never disagree with themselves within one file', () => {
    const conflicting = withDirective
      .filter((entry) => new Set(entry.occurrences.map((o) => o.value)).size > 1)
      .map((entry) => `${entry.path} (${entry.occurrences.map((o) => o.value).join(', ')})`);

    expect(
      conflicting,
      'Vitest takes the first match in the file, so a second, different value is ' +
        'silently ignored and the file runs somewhere its author did not intend.'
    ).toEqual([]);
  });

  it('name an environment this repo actually installs', () => {
    // `happy-dom` and `jsdom` are dependencies; `node` needs nothing. Anything
    // else resolves to a `vitest-environment-*` package that is not installed,
    // and the failure names a missing module rather than a typo.
    const known = new Set(['node', 'happy-dom', 'jsdom', 'edge-runtime']);
    const unknown = withDirective
      .flatMap((entry) => entry.occurrences.map((o) => ({ path: entry.path, value: o.value })))
      .filter((entry) => !known.has(entry.value))
      .map((entry) => `${entry.path} → ${entry.value}`);

    expect(unknown).toEqual([]);
  });
});
