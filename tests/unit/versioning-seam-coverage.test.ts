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
 * barrels. This test is the check, and it borrows its idea from the
 * `SEAM_DEFAULTS` drift guard in `tests/unit/lib/app/defaults.test.ts` — read
 * the directory rather than trust a table to be complete.
 *
 * The borrowing stops at the idea. That guard still classifies with a two-item
 * extension allowlist over top-level files only, which are exactly the two
 * defects corrected here after review, so a fork adding `lib/app/theme.mts` or
 * `lib/app/orders/` fails THIS guard loudly while that one accepts it in
 * silence — as does `fork-init-seams.test.ts`, which is `.ts`-only. Tracked as
 * **#734** rather than folded in here: a `SEAM_DEFAULTS` row costs a fork an
 * assertion function, not a line, so widening what demands one is its own
 * decision.
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
  return classifyEntries(readdirSync(APP_DIR, { withFileTypes: true }));
}

/** The minimal shape {@link classifyEntries} needs — what `withFileTypes` gives back. */
interface DirEntryLike {
  name: string;
  isDirectory: () => boolean;
}

/**
 * The classifier itself, split from the `readdirSync` call so a test can drive
 * it with entries this directory does not currently contain.
 *
 * That split is the whole reason it exists. The nested-directory case has no
 * example upstream — `lib/app/` is flat today — so the test for it originally
 * re-implemented this filter/map inline, which meant it asserted a copy of the
 * logic rather than the logic: adding `.filter(e => e.isFile())` here would
 * have left all five tests green while nested seams dropped out of the
 * contract. A verification that cannot fail is not one.
 */
function classifyEntries(entries: readonly DirEntryLike[]): string[] {
  return entries
    .filter((e) => !NOT_A_SEAM.some((rx) => rx.test(e.name)))
    .map((e) => (e.isDirectory() ? `lib/app/${e.name}/` : `lib/app/${e.name}`))
    .sort();
}

/**
 * The `lib/app/` paths named in VERSIONING.md's Covered section.
 *
 * **Both halves of this are exclusion rules, and that is the point.** Three
 * review rounds on this file each found the same shape in a different place —
 * a classifier narrower than the thing it classifies — so the property is
 * stated here rather than patched a fourth time: *every boundary in this guard
 * says what is NOT a scaffold, never enumerates what is.* It held on the disk
 * side (an extension allowlist missed `.mts`; a files-only read missed nested
 * seams) and it holds here on the document side.
 *
 * **Anchored to the bullet, not the section.** A section-wide scan counted a
 * path mentioned anywhere in prose as a contract row, so deleting a row and
 * writing its full path in a sentence above left the guard green with the seam
 * out of the contract. That is not hypothetical: the preamble already names
 * `brand.ts`, `public-nav.ts` and `emails.ts` by bare filename, one clarifying
 * `lib/app/` prefix away from making those three rows silently deletable.
 *
 * **The name is anything but whitespace, a backtick or `*`.** It has to accept
 * whatever {@link classifyEntries} emits, which is whatever `readdirSync`
 * returns. An `[A-Za-z0-9._-]+` class looked unconstrained and was not:
 * `lib/app/café.ts` — or any name with a space, `+`, `~` or `@` — demanded a
 * row the parser then could not see, leaving a fork in a red it had no way to
 * clear. Excluding `*` is the whole of what keeps the `lib/app/**` glob in the
 * ESLint entry from being read as a scaffold.
 *
 * What it does NOT check is the `→ export` column beside each path: this
 * compares filenames only. A row whose export name is wrong stays green — and
 * that is a live failure mode, not a theoretical one, since this branch found
 * `registerAppDriftProbe()` in the list where the actual export is
 * `registerAppDriftProbes()`.
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
  for (const line of covered.split('\n')) {
    const m = /^\s*-\s+`(lib\/app\/[^\s`*]+)`/.exec(line);
    if (m) found.add(m[1]);
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
    // Upstream ships no nested seam today, so this drives the real classifier
    // with entries the directory does not contain — NOT a copy of it, which is
    // what the first version of this test did and why it could not have failed.
    const derived = classifyEntries([
      { name: 'orders', isDirectory: () => true },
      { name: 'brand.ts', isDirectory: () => false },
      { name: '.DS_Store', isDirectory: () => false },
    ]);

    expect(derived).toEqual(['lib/app/brand.ts', 'lib/app/orders/']);
  });
});
