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
import { join, matchesGlob } from 'node:path';

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
  // Vitest matches the changed files' ABSOLUTE paths, so this must too: a glob
  // without `**/` would pass a relative-path check and never fire in a real
  // run. A fixed root stands in for the checkout, because `matchesGlob` will
  // not let `**` cross a dot-directory (a worktree under `.claude/`, say),
  // where vitest's own matcher runs with `dot: true`.
  const absolute = `/checkout/${relativePath}`;
  return triggers().some((glob) => matchesGlob(absolute, glob));
}

describe('forceRerunTriggers', () => {
  it('is exactly the lockfile, the vitest/vite config, tests/setup.ts and tsconfig.json', () => {
    expect(triggers()).toEqual([
      '**/package-lock.json',
      '**/{vitest,vite}.config.*',
      '**/tests/setup.ts',
      '**/tsconfig.json',
    ]);
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

describe('the tests that read package.json as text always run', () => {
  // With `package.json` off the trigger list, these are reached on a script
  // edit only through `ALWAYS_RUN_TESTS`. Each reads the repo's own
  // `package.json` from disk; tests that mock `fs` or write a fixture do not
  // belong here.
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
    const job = /\n {2}test-changed:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/.exec(workflow)?.[1];
    expect(
      job,
      'ci.yml no longer has a `test-changed` job — this guard cannot see it'
    ).toBeDefined();
    return job ?? '';
  }

  function runLines(job: string): string[] {
    return [...job.matchAll(/^\s*- run: (.+)$/gm)].map((match) => match[1].trim());
  }

  it('runs the scoped runner, so the always-run union applies', () => {
    const runs = runLines(testChangedJob());
    expect(runs).toContain(
      'npx tsx scripts/ci/run-scoped-tests.ts --base ${{ github.event.pull_request.base.sha }} --no-fetch --passWithNoTests'
    );
  });

  it('does not call vitest --changed directly, which would skip the always-run tests', () => {
    const direct = runLines(testChangedJob()).filter((run) => /\bvitest\b.*--changed\b/.test(run));
    expect(direct).toEqual([]);
  });
});
