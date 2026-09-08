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
 * Six named seams live outside `lib/app/` and nothing derives them, so they
 * stay hand-maintained in `VERSIONING.md`:
 *
 *   - the erasure-hook registry (`lib/privacy/erasure-hooks.ts`)
 *   - the tenancy seam (`TENANCY_MODE` + `lib/db/client.ts`)
 *   - the ESLint app-boundary rule governing `lib/app/**` (root `eslint.config.mjs`)
 *   - the brand mark component (`components/brand/brand-mark.tsx`)
 *   - the fork theme (`app/brand-theme.css`)
 *   - the fork schema tier (`prisma/schema/app.prisma`)
 *
 * Three of those six were themselves missing when this guard was written, and
 * were found by the review round that also caught the extension allowlist. That
 * is the standing risk in this half: it is a hand-maintained list inside a
 * document that calls itself the public surface. Check it against the tree.
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
 * A fork that adds its own scaffold under `lib/app/` — a file of any
 * extension, or a directory — will fail this test until it adds the row. That
 * is the test working: your scaffold is public surface for whoever forks
 * *you*, and the list is where you say so.
 *
 * @see VERSIONING.md · .context/architecture/fork-init-seams.md
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const VERSIONING_MD = path.join(process.cwd(), 'VERSIONING.md');
const APP_DIR = path.join(process.cwd(), 'lib/app');

/**
 * Names that are not a seam. **Everything else in `lib/app/` is**, whatever its
 * extension.
 *
 * A deny-list, deliberately, and this is the whole design of the function
 * below. The first version of it allowed five extensions —
 * `ts|tsx|mjs|cjs|js` — which is the same enumerating shape this file exists to
 * replace, moved one item along: `lib/app/theme.mts` passed it silently, and by
 * `VERSIONING.md`'s own rule that file would then be owed no breaking-change
 * announcement. An allowlist of extensions can only be as complete as whoever
 * last thought about it. A deny-list fails the other way — a new kind of
 * scaffold is loud, and the answer to a false positive is one line here with a
 * reason attached.
 */
const NOT_A_SEAM = [
  /^\./, //         dotfiles — tooling, not surface
  /\.d\.ts$/, //    ambient declarations, not a scaffold a fork fills
  /\.md$/, //       documentation that happens to sit beside the seams
];

/**
 * The scaffolds on disk, as the contract names them.
 *
 * **A directory counts as one scaffold**, listed with a trailing slash, rather
 * than as each file inside it. `lib/app/` is not flat: the root ESLint config
 * scopes the app-boundary rule to `lib/app/**` and its own violation message
 * names `lib/app/<name>/server/` as the supported shape for a Node-only seam.
 * A version that read only the top-level *files* could not see a nested seam at
 * all — verified against `lib/app/zz-sub/seam.ts`, which it passed green.
 *
 * Naming the directory rather than its files is what keeps the contract at one
 * row per seam: a fork's `lib/app/orders/server/{index,handlers,types}.ts` is
 * one extension point, and three rows describing its internals would be a list
 * about implementation rather than surface.
 */
function scaffoldsOnDisk(): string[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((e) => !NOT_A_SEAM.some((rx) => rx.test(e.name)))
    .map((e) => (e.isDirectory() ? `lib/app/${e.name}/` : `lib/app/${e.name}`))
    .sort();
}

/**
 * The `lib/app/` paths named in VERSIONING.md's Covered section.
 *
 * Scoped to that section deliberately: a path mentioned under "Not covered", or
 * in the prose above it, must not count as coverage. Matches a backticked path
 * that ends in an extension or a trailing slash — the two forms
 * {@link scaffoldsOnDisk} produces — so the `lib/app/**` glob in the ESLint
 * entry is not mistaken for a scaffold.
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
  for (const m of covered.matchAll(/`(lib\/app\/[A-Za-z0-9._-]+(?:\.[A-Za-z0-9]+|\/))`/g)) {
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

  it('classifies by a deny-list, so an unfamiliar extension is a finding', () => {
    // The `.mjs` canary above only proves the ONE extension someone remembered.
    // This proves the rule: a scaffold nobody anticipated must be surfaced, not
    // skipped. `.mts` is the concrete miss the first version of this file
    // shipped, and the assertion is written against the classifier so it keeps
    // holding for whatever extension arrives next.
    const classify = (name: string) => !NOT_A_SEAM.some((rx) => rx.test(name));

    expect(classify('theme.mts'), '.mts must count as a seam').toBe(true);
    expect(classify('config.json'), '.json must count as a seam').toBe(true);
    expect(classify('tokens.css'), '.css must count as a seam').toBe(true);

    expect(classify('types.d.ts'), 'ambient declarations are not a seam').toBe(false);
    expect(classify('.gitkeep'), 'dotfiles are not a seam').toBe(false);
    expect(classify('README.md'), 'docs beside the seams are not a seam').toBe(false);
  });

  it('sees a nested seam directory, which lib/app is expected to contain', () => {
    // `lib/app/` is not flat — the root ESLint config's own violation message
    // points a fork at `lib/app/<name>/server/` for a Node-only seam. A
    // top-level-files-only scan passed `lib/app/zz-sub/seam.ts` green, so the
    // contract would have been silent about an entire extension point.
    // Upstream ships none today, which is exactly why this asserts the
    // classifier's behaviour rather than the current directory listing.
    const entries = [
      { name: 'orders', isDirectory: () => true },
      { name: 'brand.ts', isDirectory: () => false },
    ];
    const derived = entries
      .filter((e) => !NOT_A_SEAM.some((rx) => rx.test(e.name)))
      .map((e) => (e.isDirectory() ? `lib/app/${e.name}/` : `lib/app/${e.name}`));

    expect(derived).toEqual(['lib/app/orders/', 'lib/app/brand.ts']);
  });
});
