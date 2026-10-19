/**
 * Hand-rolled `next/navigation` router mocks check: CLI.
 *
 * The rules, and why this is needed at all, live in `scripts/ci/router-mocks.ts`.
 * This file only walks `tests/` and hands file contents over.
 *
 * ## Why the whole tree, every time
 *
 * Deliberately repo-wide rather than scoped to a branch's diff. Both invariants
 * are meant to hold at zero, so a whole-repo count *is* the check, and a
 * diff-scoped version is blind to every pre-existing violation until someone
 * happens to re-touch those exact lines. That is not hypothetical: the first
 * version of this check was diff-scoped and could not see the files it was
 * written to catch.
 *
 * Usage:
 *   npm run check:router-mocks
 */

import { readdirSync, readFileSync } from 'fs';
import { posix, sep } from 'path';

import {
  formatViolation,
  scanRouterMocks,
  type RouterMockViolation,
} from '@/scripts/ci/router-mocks';

/** Where the suite lives. */
const ROOT = 'tests';

/**
 * The factory's own definition necessarily writes a complete router out, so it
 * is exempt from the `literal` rule, and from that rule only. See
 * `ScanOptions.allowCompleteLiteral`.
 */
const COMPLETE_LITERAL_ALLOWED = new Set(['tests/types/mocks.ts']);

/** Every `.ts`/`.tsx` under `tests/`, repo-relative, in sorted order. */
export function listTestSources(root = process.cwd()): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(posix.join(root, ROOT), { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  return entries
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => posix.join(ROOT, entry))
    .sort();
}

export function main(root = process.cwd()): number {
  const files = listTestSources(root);

  // Zero files means the check did not look, not that the suite is clean. Run
  // from anywhere but the repo root, `readdirSync` throws and this would
  // otherwise print an all-clear naming a count of nothing. The sibling
  // barrel and lockfile checks fail loudly in the same situation, and an
  // all-clear that overstates its own coverage is the failure mode this whole
  // check exists to prevent.
  if (files.length === 0) {
    console.error(`Found no .ts/.tsx files under ${ROOT}/. Is this the repo root?`);
    console.error(`Looked under ${root}.`);
    return 1;
  }

  const violations: RouterMockViolation[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(posix.join(root, file), 'utf8');
    } catch (error) {
      // A directory named like a source file (`fixtures.ts/`) comes back from
      // the recursive listing too, and is nothing to scan.
      if (error instanceof Error && 'code' in error && error.code === 'EISDIR') continue;
      // Reported rather than skipped: "I could not look" and "there is nothing
      // there" are different answers, and only one of them is a pass.
      unreadable.push(file);
      continue;
    }
    violations.push(
      ...scanRouterMocks(source, file, {
        allowCompleteLiteral: COMPLETE_LITERAL_ALLOWED.has(file),
      })
    );
  }

  if (unreadable.length > 0) {
    console.error('Could not read:');
    for (const file of unreadable) console.error(`  ${file}`);
  }

  if (violations.length > 0) {
    console.error(`Hand-rolled router mocks found (${violations.length}):`);
    for (const violation of violations) console.error(`  ${formatViolation(violation)}`);
    console.error('');
    console.error(
      "Build the router with `createMockRouter()` from '@/tests/types/mocks', " +
        'passing only the spies the test asserts on:'
    );
    console.error('  vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh }));');
    console.error('');
    console.error('See .context/testing/mocking.md for the full pattern.');
    return 1;
  }

  if (unreadable.length > 0) return 1;

  // Names the coverage it actually had. A bare "OK" cannot be told apart from
  // an OK over three files.
  console.log(`Router mocks OK (${files.length} files under ${ROOT}/ scanned).`);
  return 0;
}

// `process.exitCode`, not `process.exit()`: stderr is asynchronous when it is
// a pipe, which it is under both `npm run` and GitHub Actions, and exiting
// discards whatever is still queued.
//
// Guarded on the entry point, as `check-missing-tests.ts` is, so importing a
// helper from here does not run the whole scan as a side effect.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-router-mocks.ts')) {
  process.exitCode = main();
}
