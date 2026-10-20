/**
 * What counts as a fork's starter file ("scaffold") under `lib/app/` — one rule
 * for every whole-tree guard that reads the directory.
 *
 * Three guards read `lib/app/`: the VERSIONING.md / CUSTOMIZATION.md coverage
 * check, the ships-empty rows in `tests/unit/lib/app/defaults.test.ts`, and the
 * shared-gate check in `tests/unit/fork-init-seams.test.ts`. Each used to decide
 * for itself — a deny-list over entries, top-level `.ts|.mjs` files, top-level
 * `.ts` files — so a `lib/app/<name>/` directory or a `.mts` file was caught by
 * the first and silently skipped by the other two (#734). `lib/app/` is flat
 * today, so they agreed by accident. Reading through here, a new kind of
 * scaffold is checked by all three or fails all three loudly.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

export const APP_DIR = path.join(process.cwd(), 'lib/app');

/**
 * Names that are not a seam. **Everything else in `lib/app/` is**, whatever its
 * extension.
 *
 * A deny-list, deliberately, and this is the whole design of the classifier.
 * The first version allowed five extensions — `ts|tsx|mjs|cjs|js` — which is
 * the same enumerating shape the guards exist to replace, moved one item along:
 * `lib/app/theme.mts` passed it silently, and by `VERSIONING.md`'s own rule that
 * file would then be owed no breaking-change announcement. An allowlist of
 * extensions can only be as complete as whoever last thought about it. A
 * deny-list fails the other way — a new kind of scaffold is loud, and the
 * answer to a false positive is one line here with a reason attached.
 */
export const NOT_A_SEAM = [
  /^\./, //         dotfiles — tooling, not surface
  /\.d\.ts$/, //    ambient declarations, not a scaffold a fork fills
  /\.md$/, //       documentation that happens to sit beside the seams
];

/** The minimal shape {@link classifyEntries} needs — what `withFileTypes` gives back. */
export interface DirEntryLike {
  name: string;
  isDirectory: () => boolean;
}

/**
 * The scaffolds among a directory's entries, as the contract names them.
 *
 * **A directory counts as one scaffold**, listed with a trailing slash, rather
 * than as each file inside it. `lib/app/` is not meant to stay flat: the root
 * ESLint config scopes the app-boundary rule to `lib/app/**` and its own
 * violation message names `lib/app/<name>/server/` as the supported shape for a
 * Node-only seam. Naming the directory keeps the contract at one row per seam:
 * a fork's `lib/app/orders/server/{index,handlers,types}.ts` is one extension
 * point, and three rows describing its internals would be a list about
 * implementation rather than surface.
 *
 * Split from the `readdirSync` call so a test can drive it with entries the
 * directory does not currently contain. A test that re-implemented this inline
 * would assert a copy of the logic rather than the logic.
 */
export function classifyEntries(entries: readonly DirEntryLike[]): string[] {
  return entries
    .filter((e) => !NOT_A_SEAM.some((rx) => rx.test(e.name)))
    .map((e) => (e.isDirectory() ? `lib/app/${e.name}/` : `lib/app/${e.name}`))
    .sort();
}

/** The scaffolds on disk: one entry per top-level file or directory in `dir`. */
export function scaffoldsOnDisk(dir: string = APP_DIR): string[] {
  return classifyEntries(readdirSync(dir, { withFileTypes: true }));
}

/**
 * Every file belonging to a scaffold, as absolute paths — a top-level file, or
 * each file under a scaffold directory at any depth. The same deny-list applies
 * at every level, so what a guard scans for `initApp*` / `registerApp*` exports
 * is exactly what {@link scaffoldsOnDisk} counts as surface.
 */
export function scaffoldSourceFiles(dir: string = APP_DIR): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_A_SEAM.some((rx) => rx.test(entry.name))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scaffoldSourceFiles(full));
    else files.push(full);
  }
  return files.sort();
}
