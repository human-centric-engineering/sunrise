/**
 * Tests: VERSIONING.md's named-seam list covers every `lib/app/` scaffold
 *
 * `VERSIONING.md` states that its Covered list **is** the public surface, and
 * that nothing else is covered by the version contract. So a scaffold missing
 * from that list is owed no breaking-change announcement — and a fork relying
 * on it has no way to discover that by reading the file. The list named seven
 * of the thirty `lib/app/` files (six when #732 was raised, before #731 added
 * the provider-eligibility seam); every fork had filled more than seven.
 *
 * The list was hand-maintained and nothing checked it. `npm run check:exports`
 * structurally cannot: it walks `lib/**\/index.ts` barrels, and these are not
 * barrels. This test is the check — the same shape as the `SEAM_DEFAULTS` drift
 * guard in `tests/unit/lib/app/defaults.test.ts`, which reads the directory
 * rather than trusting a table to be complete.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT COVER
 * ---------------------------------------------------------------------------
 * Three named seams live outside `lib/app/` and nothing derives them, so they
 * stay hand-maintained in `VERSIONING.md`:
 *
 *   - the erasure-hook registry (`lib/privacy/erasure-hooks.ts`)
 *   - the tenancy seam (`TENANCY_MODE` + `lib/db/client.ts`)
 *   - the ESLint app-boundary rule governing `lib/app/**` (root `eslint.config.mjs`)
 *
 * Nor does it cover the Covered list's other two categories — documented public
 * APIs and published Prisma model interfaces — which are a different question
 * with a different derivation. A green run here means "the `lib/app/` half of
 * the list matches the directory", never "the public-surface list is complete".
 * Stating that edge is the point: a check read as proving more than it does is
 * how the list went short in the first place.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE
 * ---------------------------------------------------------------------------
 * A fork that adds its own `lib/app/*` file will fail this test until it adds
 * the row. That is the test working — your scaffold is public surface for
 * whoever forks *you*, and the list is where you say so.
 *
 * @see VERSIONING.md · .context/architecture/fork-init-seams.md
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const VERSIONING_MD = path.join(process.cwd(), 'VERSIONING.md');
const APP_DIR = path.join(process.cwd(), 'lib/app');

/**
 * The scaffolds on disk.
 *
 * Globs the directory, NOT `*.ts`. `lib/app/eslint.config.mjs` is one of them,
 * and a `.ts`-only scan passes while silently exempting it — the exact class of
 * miss that produced #732, whose own derived roster missed the same file.
 */
function scaffoldsOnDisk(): string[] {
  return readdirSync(APP_DIR)
    .filter((f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => `lib/app/${f}`)
    .sort();
}

/**
 * The `lib/app/` paths named in VERSIONING.md's Covered section.
 *
 * Scoped to that section deliberately: a path mentioned under "Not covered", or
 * in the prose above it, must not count as coverage. Matches a backticked path
 * with a real extension, so the `lib/app/**` glob in the ESLint entry is not
 * mistaken for a file.
 */
function scaffoldsNamedInVersioning(markdown: string): string[] {
  const start = markdown.indexOf('### Covered');
  const end = markdown.indexOf('### Not covered');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'VERSIONING.md no longer has a "### Covered" section ending at "### Not covered". ' +
        'This guard reads those headings to know where the public-surface list is; ' +
        'if the document was restructured, teach it the new shape rather than deleting it.'
    );
  }
  const covered = markdown.slice(start, end);
  const found = new Set<string>();
  for (const m of covered.matchAll(/`(lib\/app\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+)`/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

describe('VERSIONING.md seam coverage', () => {
  const markdown = readFileSync(VERSIONING_MD, 'utf8');
  const onDisk = scaffoldsOnDisk();
  const named = scaffoldsNamedInVersioning(markdown);

  it('names every scaffold in lib/app/', () => {
    const missing = onDisk.filter((f) => !named.includes(f));

    expect(
      missing,
      "These lib/app/ scaffolds are not named in VERSIONING.md's Covered list. " +
        'That file states the list IS the public surface, so an unnamed scaffold is ' +
        'owed no breaking-change announcement — and a fork filling it cannot tell. ' +
        'Add a row rather than narrowing the rule: widening the contract is a MINOR, ' +
        'narrowing it is a MAJOR.'
    ).toEqual([]);
  });

  it('does not name a scaffold that no longer exists', () => {
    const stale = named.filter((f) => !onDisk.includes(f));

    expect(
      stale,
      'VERSIONING.md names these lib/app/ files, but they are not on disk. A rename ' +
        'that updates the file and not the list leaves the contract pointing at nothing.'
    ).toEqual([]);
  });

  it('covers the .mjs scaffold, not just the TypeScript ones', () => {
    // A canary for the specific bug, not a restatement of the test above. A
    // `*.ts` glob passes every assertion here while leaving `eslint.config.mjs`
    // unlisted — which is what #732's own derived roster did. If this file is
    // ever renamed away, this assertion should be re-aimed at whatever
    // non-`.ts` scaffold replaces it, not deleted.
    expect(onDisk).toContain('lib/app/eslint.config.mjs');
    expect(named).toContain('lib/app/eslint.config.mjs');
  });
});
