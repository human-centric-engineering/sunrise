/**
 * The scoped coverage gate, run for real (t-749).
 *
 * `buildVitestArgv`'s coverage flags are handed to an actual `vitest run` over
 * two fixture sources: one fully covered, one at 50% branches. Their average
 * clears 80% on every metric, so a gate that checks the average passes. The
 * floor is meant to land on each file, so the run must fail and name the
 * thin one.
 *
 * That is the failure this gate shipped with: `--coverage.thresholds.perFile=true`
 * parses to the string "true", which vitest does not treat as on, and the run
 * exited 0. The unit tests ask vitest's parser; this asks vitest.
 *
 * The fixture is written under the repo root (removed afterwards) so the child
 * resolves `@vitest/coverage-v8` from the repo's own `node_modules`. It runs
 * with its own minimal config, so the repo's coverage excludes don't apply.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { vitestEntry } from '@/scripts/ci/run-scoped-tests';
import { buildVitestArgv } from '@/scripts/ci/scoped-tests';

const ROOT = resolve(__dirname, '../../../..');

/** Eight branches, every one exercised. */
const WELL = `export function well(n) {
  if (n === 1) return 'one';
  if (n === 2) return 'two';
  if (n === 3) return 'three';
  return 'many';
}
`;

/** Two branches, one exercised: 50% branches. */
const THIN = `export function thin(n) {
  if (n > 0) {
    return 'positive';
  }
  return 'not positive';
}
`;

const CHECK = `import { expect, it } from 'vitest';
import { well } from './well.mjs';
import { thin } from './thin.mjs';

it('exercises well fully and thin on one side', () => {
  expect([1, 2, 3, 4].map(well)).toEqual(['one', 'two', 'three', 'many']);
  expect(thin(1)).toBe('positive');
});
`;

const CONFIG = `export default {
  test: {
    include: ['*.check.mjs'],
    coverage: { provider: 'v8', reporter: ['text'] },
  },
};
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(ROOT, '.coverage-floor-'));
  writeFileSync(join(dir, 'well.mjs'), WELL);
  writeFileSync(join(dir, 'thin.mjs'), THIN);
  writeFileSync(join(dir, 'floor.check.mjs'), CHECK);
  writeFileSync(join(dir, 'vitest.config.mjs'), CONFIG);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the scoped coverage floor, under a real vitest run', () => {
  it('fails the run on a file below 80% even when the average clears it, naming the file', () => {
    const entry = vitestEntry(ROOT);
    if (!entry) throw new Error('vitest is not installed at node_modules/vitest');

    const argv = buildVitestArgv({
      selected: ['floor.check.mjs'],
      alwaysRun: [],
      coverage: ['well.mjs', 'thin.mjs'],
      threshold: 80,
    });
    const run = spawnSync(
      process.execPath,
      [entry, ...argv, '--root', dir, '--config', join(dir, 'vitest.config.mjs')],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' } }
    );
    const output = `${run.stdout}\n${run.stderr}`;

    // The premise: the fixture's test itself passed, and the average clears 80.
    expect(output).toMatch(/1 passed/);
    expect(output).toMatch(/All files\s*\|\s*(9\d|100)(\.\d+)?\s*\|\s*(8\d|9\d|100)/);
    // The floor: the run fails, on the thin file, for branches.
    expect(run.status).toBe(1);
    expect(output).toMatch(/Coverage for branches \(50%\) does not meet .* for .*thin\.mjs/);
    expect(output).not.toMatch(/for .*well\.mjs/);
  }, 60_000);
});
