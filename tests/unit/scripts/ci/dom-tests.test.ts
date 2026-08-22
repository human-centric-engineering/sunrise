/**
 * Tests for the DOM-failure classifier.
 *
 * The property that matters is not "does it find DOM failures" — it is **does
 * it refuse everything else.** This tool writes to a fork's test files, and the
 * direction it must never get wrong is adding a directive to a file that did
 * not need one: that file then passes while quietly reading the client half of
 * `lib/env.ts`'s schema, which is the exact thing the node default exists to
 * stop. So most of what follows checks that a failure is left alone.
 *
 * @see scripts/ci/dom-tests.ts
 */

import { describe, it, expect } from 'vitest';

import {
  DIRECTIVE,
  classify,
  domGlobalsMissingHere,
  selfTestFailure,
  undefinedNames,
  withDirective,
  withoutDirective,
  type FailedFile,
} from '@/scripts/ci/dom-tests';

/**
 * A `node` directive, assembled at runtime.
 *
 * Written out in full it would apply to *this* file — vitest matches the
 * directive anywhere in a source, not just on line 1. The guard in
 * `tests/unit/vitest-environment-directives.test.ts` caught exactly that here,
 * naming the line, which is what that guard is for.
 */
const NODE_DIRECTIVE = `// @vitest-${'environment'} node`;

const file = (overrides: Partial<FailedFile> = {}): FailedFile => ({
  path: 'tests/unit/x.test.ts',
  messages: [],
  source: 'const a = 1;\n',
  ...overrides,
});

describe('undefinedNames', () => {
  it('reads the in-test failure shape', () => {
    expect(undefinedNames('ReferenceError: document is not defined\n    at render (...)')).toEqual([
      'document',
    ]);
  });

  it('reads the import-time shape, which carries no ReferenceError prefix', () => {
    // Measured against vitest 4.1.10: a failure while importing the file lands
    // in the file's own `message` as a bare string, with no assertionResults.
    // A matcher requiring the prefix would miss every test whose subject
    // touches the DOM at module scope.
    expect(undefinedNames('document is not defined')).toEqual(['document']);
  });

  it('collects every distinct global a message names', () => {
    expect(
      undefinedNames(
        'ReferenceError: window is not defined\nReferenceError: localStorage is not defined'
      )
    ).toEqual(['window', 'localStorage']);
  });

  it('reports nothing for a message that names nothing undefined', () => {
    expect(undefinedNames('AssertionError: expected 1 to be 2')).toEqual([]);
  });
});

describe('domGlobalsMissingHere', () => {
  it('excludes globals this Node already provides', () => {
    // The list is filtered against the running process rather than trusted as
    // written, so a global Node adopts later stops counting as a DOM signal
    // with nothing to remember to delete.
    const missing = domGlobalsMissingHere();
    for (const present of ['fetch', 'Response', 'navigator']) {
      expect(missing.has(present)).toBe(false);
    }
  });

  it('includes the browser globals Node does not have', () => {
    const missing = domGlobalsMissingHere();
    expect(missing.has('document')).toBe(true);
    expect(missing.has('window')).toBe(true);
  });

  it('drops a name once the host provides it', () => {
    const missing = domGlobalsMissingHere((name) => name === 'document' || name in globalThis);
    expect(missing.has('document')).toBe(false);
    expect(missing.has('window')).toBe(true);
  });
});

describe('classify', () => {
  const missing = new Set(['document', 'window']);

  it('proposes a directive for a file that failed on a missing browser global', () => {
    const verdict = classify(
      [file({ messages: ['ReferenceError: document is not defined'] })],
      missing
    );
    expect(verdict.candidates).toEqual([{ path: 'tests/unit/x.test.ts', missing: ['document'] }]);
  });

  it('leaves an ordinary assertion failure alone', () => {
    // The line between "migration aid" and "makes the suite green by force".
    const verdict = classify([file({ messages: ['expected 1 to be 2'] })], missing);
    expect(verdict.candidates).toEqual([]);
    expect(verdict.unrelated).toEqual(['tests/unit/x.test.ts']);
  });

  it('leaves a ReferenceError for something Node does have alone', () => {
    // `fetch is not defined` is a real fault, not a missing environment — and
    // happy-dom would not fix it.
    const verdict = classify(
      [file({ messages: ['ReferenceError: fetch is not defined'] })],
      missing
    );
    expect(verdict.candidates).toEqual([]);
    expect(verdict.unrelated).toEqual(['tests/unit/x.test.ts']);
  });

  it('never adds a second directive to a file that already has one', () => {
    const verdict = classify(
      [
        file({
          messages: ['ReferenceError: document is not defined'],
          source: `${DIRECTIVE}\n\nconst a = 1;\n`,
        }),
      ],
      missing
    );
    expect(verdict.candidates).toEqual([]);
    expect(verdict.alreadyDeclared).toEqual([
      { path: 'tests/unit/x.test.ts', environment: 'happy-dom' },
    ]);
  });

  it('honours an explicit node directive rather than overriding it', () => {
    // A file pinned to node that fails on `document` is telling you something
    // about itself. Flipping it to happy-dom would erase the statement.
    const verdict = classify(
      [
        file({
          messages: ['ReferenceError: document is not defined'],
          source: `${NODE_DIRECTIVE}\n\nconst a = 1;\n`,
        }),
      ],
      missing
    );
    expect(verdict.candidates).toEqual([]);
    expect(verdict.alreadyDeclared).toEqual([
      { path: 'tests/unit/x.test.ts', environment: 'node' },
    ]);
  });

  it('reads both message channels, not just assertion failures', () => {
    const verdict = classify([file({ messages: ['window is not defined'] })], missing);
    expect(verdict.candidates[0]?.missing).toEqual(['window']);
  });
});

describe('withDirective / withoutDirective', () => {
  it('puts the directive on line 1, where vitest and the guard both expect it', () => {
    expect(withDirective('const a = 1;\n')).toBe(`${DIRECTIVE}\n\nconst a = 1;\n`);
  });

  it('refuses a file that already declares an environment', () => {
    expect(withDirective(`${DIRECTIVE}\nx`)).toBeNull();
    expect(withDirective(`${NODE_DIRECTIVE}\nx`)).toBeNull();
  });

  it('round-trips, so an unjustified directive can be taken back out', () => {
    const original = 'const a = 1;\n';
    expect(withoutDirective(withDirective(original) as string)).toBe(original);
  });

  it('leaves a file it did not write alone', () => {
    expect(withoutDirective('const a = 1;\n')).toBe('const a = 1;\n');
  });
});

describe('selfTestFailure', () => {
  it('passes on the module as shipped', () => {
    expect(selfTestFailure()).toBeNull();
  });

  it('catches a matcher that has stopped matching', () => {
    // The failure mode the sentinel exists for. `[]` from a dead regex reads as
    // "nothing to fix" — which, for a fork mid-merge, means annotating 350
    // files by hand because a tool said there was nothing to do.
    expect(selfTestFailure({ names: () => [] })).toContain('in-test failure shape');
  });

  it('catches a matcher that only reads the in-test shape', () => {
    // Import-time failures carry no `ReferenceError:` prefix, and a matcher
    // requiring one misses every test whose subject touches the DOM at module
    // scope.
    const names = (message: string): string[] =>
      message.startsWith('ReferenceError:') ? undefinedNames(message) : [];
    expect(selfTestFailure({ names })).toContain('import-time shape');
  });

  it('catches a matcher that reports something undefined in a clean message', () => {
    // Wrong only for the third probe — a blunter stub trips an earlier check
    // and reports that instead, which is a test asserting on the wrong branch.
    const names = (message: string): string[] =>
      message === 'everything is fine' ? ['document'] : undefinedNames(message);
    expect(selfTestFailure({ names })).toContain('reports nothing undefined');
  });

  it('catches a classifier that proposes the wrong file', () => {
    const sort = (): ReturnType<typeof classify> => ({
      candidates: [{ path: 'wrong.test.ts', missing: ['document'] }],
      alreadyDeclared: [],
      unrelated: [],
    });
    expect(selfTestFailure({ sort })).toContain('expected only a.test.ts');
  });

  it('catches a classifier that stopped separating unrelated failures', () => {
    const sort = (
      files: readonly FailedFile[],
      missingGlobals: Set<string>
    ): ReturnType<typeof classify> => {
      const real = classify(files, missingGlobals);
      return { ...real, unrelated: [] };
    };
    expect(selfTestFailure({ sort })).toContain('unrelated to the environment');
  });

  it('catches a classifier that would double-declare', () => {
    const sort = (
      files: readonly FailedFile[],
      missingGlobals: Set<string>
    ): ReturnType<typeof classify> => {
      const real = classify(files, missingGlobals);
      return { ...real, alreadyDeclared: [] };
    };
    expect(selfTestFailure({ sort })).toContain('already has one');
  });

  it('catches a writer that misplaces the directive', () => {
    expect(selfTestFailure({ add: () => 'nope' })).toContain('line 1');
  });

  it('catches a writer that would overwrite an existing directive', () => {
    expect(selfTestFailure({ add: (source) => `${DIRECTIVE}\n\n${source}` })).toContain(
      'overwrite an existing directive'
    );
  });

  it('catches a revert that cannot undo the write', () => {
    expect(selfTestFailure({ remove: (source) => source })).toContain('cannot undo');
  });

  it('catches a global list that has stopped filtering against the host', () => {
    // If `fetch` counted as a missing DOM global, a real fault would be
    // "fixed" by adding a DOM that has nothing to do with it.
    expect(selfTestFailure({ missing: () => new Set(['document', 'fetch']) })).toContain(
      'but Node has it'
    );
  });

  it('catches a global list with nothing in it', () => {
    expect(selfTestFailure({ missing: () => new Set<string>() })).toContain(
      'nothing would ever be proposed'
    );
  });
});
