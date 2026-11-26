/**
 * Tests: what makes a scoped run run everything, and what CI's scoped run runs.
 *
 * Two halves of one decision (#1331, #1351):
 *
 *   1. `vitest.config.ts` sets `forceRerunTriggers` explicitly, so a script
 *      edit to `package.json` no longer forces the whole suite under
 *      `vitest --changed`, while the lockfile, the vitest config,
 *      `tests/setup.ts` and `tsconfig.json` do.
 *   2. Dropping `package.json` is only safe because the tests that read it as
 *      text are in `ALWAYS_RUN_TESTS`, and CI's `test-changed` job runs that
 *      list. If the job went back to a bare `vitest --changed`, a script edit
 *      that broke one of them would pass the PR and fail only on `main`.
 *
 * Neither half is reached through an import chain from the file it guards (the
 * workflow is YAML, read as text), so this file is in `ALWAYS_RUN_TESTS`.
 *
 * @see vitest.config.ts — the trigger list and why `package.json` is left out
 * @see .github/workflows/ci.yml — the `test-changed` job
 * @see scripts/ci/scoped-tests.ts — `ALWAYS_RUN_TESTS`
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';

import config from '@/vitest.config';
import { alwaysRunPaths } from '@/scripts/ci/scoped-tests';

const ROOT = process.cwd();

function triggers(): string[] {
  const list = config.test?.forceRerunTriggers;
  expect(list, 'vitest.config.ts no longer sets `forceRerunTriggers`').toBeDefined();
  return list ?? [];
}

/** Whether vitest would treat a change to this repo-relative file as "run everything". */
function forcesFullRun(relativePath: string): boolean {
  // The same call vitest makes on `--changed` (`picomatch(forceRerunTriggers,
  // { dot: true })`, in its CLI API), against the same ABSOLUTE paths: a glob
  // without `**/` would pass a relative-path check and never fire in a real
  // run. Node's `path.matchesGlob` agrees on simple globs but not on extglobs,
  // dot segments or every brace form, so a trigger checked with it could pass
  // here and never fire in vitest, or the reverse. This imports the root
  // `picomatch`; the test below fails if Vitest resolves a different copy.
  // Slashes are normalised because Vitest's changed-file paths are, and
  // picomatch treats only `/` as a separator.
  return picomatch(triggers(), { dot: true })(join(ROOT, relativePath).replaceAll('\\', '/'));
}

describe('forceRerunTriggers', () => {
  it('is matched here with the same picomatch copy vitest resolves', () => {
    // If a Vitest bump nests its own picomatch (a new major), the matcher above
    // is no longer the one Vitest calls, and its cases prove nothing.
    const fromRoot = createRequire(join(ROOT, 'package.json'));
    const fromVitest = createRequire(fromRoot.resolve('vitest/package.json'));
    expect(fromVitest.resolve('picomatch')).toBe(fromRoot.resolve('picomatch'));
  });

  it('includes the lockfile, the vitest/vite config, tests/setup.ts and tsconfig.json', () => {
    // Containment, not equality: a fork may add a trigger of its own without
    // editing this platform-owned test.
    expect(triggers()).toEqual(
      expect.arrayContaining([
        '**/package-lock.json',
        '**/{vitest,vite}.config.*',
        '**/tests/setup.ts',
        '**/tsconfig.json',
      ])
    );
  });

  it.each(['package-lock.json', 'vitest.config.ts', 'tests/setup.ts', 'tsconfig.json'])(
    'a change to %s runs the whole suite',
    (file) => {
      expect(forcesFullRun(file)).toBe(true);
    }
  );

  it('a change to package.json does not run the whole suite', () => {
    // The point of #1331: almost every edit is a script line, which no test
    // imports, and the full run it forced cost forks 50+ minutes per PR.
    expect(forcesFullRun('package.json')).toBe(false);
  });

  it('an ordinary source file is left to the module graph', () => {
    expect(forcesFullRun('lib/logging/index.ts')).toBe(false);
  });
});

describe('the known package.json readers are in ALWAYS_RUN_TESTS', () => {
  // With `package.json` off the trigger list, these are reached on a script
  // edit only through `ALWAYS_RUN_TESTS`. Each reads the repo's own
  // `package.json` from disk; tests that mock `fs` or write a fixture do not
  // belong here.
  //
  // This pins the readers known when the trigger was dropped (#1331). It does
  // not find new ones: the list is written, not derived, for the reasons in
  // the header of `scripts/ci/scoped-tests.ts`. A new reader has to be added
  // to `ALWAYS_RUN_TESTS` (or `lib/app/ci.ts` in a fork) by hand.
  it.each([
    'tests/unit/scripts/run-capped.test.ts',
    'tests/unit/scripts/ci/validate-changed.test.ts',
    'tests/unit/toolchain-cache-location.test.ts',
    'tests/unit/lib/auth/better-auth-single-core.test.ts',
  ])('%s is in ALWAYS_RUN_TESTS', (path) => {
    expect(alwaysRunPaths()).toContain(path);
  });
});

describe("CI's test-changed job", () => {
  function testChangedJob(): string {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    // From the job key to the next top-level job (two-space indent).
    // Ends at any column-2 key, so a trailing comment or space on the next
    // job's key does not let the match run on into later jobs.
    const job = /\n {2}test-changed:[^\n]*\n([\s\S]*?)(?=\n {2}[\w-]+:)/.exec(workflow)?.[1];
    expect(
      job,
      'ci.yml no longer has a `test-changed` job — this guard cannot see it'
    ).toBeDefined();
    return job ?? '';
  }

  function runLines(job: string): string[] {
    // `- run:` and a `run:` under `- name:` both count.
    return [...job.matchAll(/^\s*(?:- )?run:\s*(.+)$/gm)].map((match) => match[1].trim());
  }

  it('runs the scoped runner, so the always-run union applies', () => {
    const runs = runLines(testChangedJob());
    expect(runs).toContain(
      'npx tsx scripts/ci/run-scoped-tests.ts --base ${{ github.event.pull_request.base.sha }} --no-fetch'
    );
  });

  it('does not call vitest --changed directly, which would skip the always-run tests', () => {
    // Every non-comment line of the job, not just `run:` values, so a
    // command inside a `run: |` block is seen too.
    const direct = testChangedJob()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /\bvitest\b.*--changed\b/.test(line));
    expect(direct).toEqual([]);
  });
});
