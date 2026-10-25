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
 *
 * The two that demand a row per seam (the documents, and `SEAM_DEFAULTS`) ask
 * through {@link unlistedSeams}, which subtracts the fork's own modules
 * (`lib/app/own-modules.ts`, #847). The shared-gate check still reads every
 * scaffold file: an `initApp*` nothing calls is dead wiring whoever owns it.
 *
 * FORK NOTE — this reads your `lib/app/own-modules.ts` for real, on purpose:
 * the modules you declare there are what the row-demanding guards skip. Leave
 * it empty unless you are a leaf fork with modules of your own in `lib/app/`;
 * `tests/unit/versioning-seam-coverage.test.ts` and `defaults.test.ts` refuse an
 * entry that names nothing or that a seam list still has a row for.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { appOwnModules } from '@/lib/app/own-modules';

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

/** The declaration file itself — a seam, so never one of a fork's own modules. */
export const OWN_MODULES_FILE = 'lib/app/own-modules.ts';

/**
 * The seams on disk that `listed` has no row for: every scaffold, less the
 * fork's own modules (`lib/app/own-modules.ts`), less `listed`. The one place a
 * row-demanding guard asks "which seams am I missing?", so a module a leaf fork
 * declares as its own is skipped by every such guard or by none.
 */
export function unlistedSeams(
  listed: Iterable<string>,
  dir: string = APP_DIR,
  ownModules: readonly string[] = appOwnModules
): string[] {
  const skip = new Set([...ownModules, ...listed]);
  return scaffoldsOnDisk(dir).filter((s) => !skip.has(s));
}

/**
 * Why each declared own module cannot be honoured; empty when all can.
 *
 * Refused rather than ignored, as `reserved-tiers.ts` refuses an unknown tier:
 * an entry that matches nothing exempts nothing, and the fork would read its
 * declaration as working. `rowsIn` names each list that treats an entry as a
 * seam (VERSIONING.md, the CUSTOMIZATION.md table, `SEAM_DEFAULTS`) with the
 * entries it has rows for. An entry still listed in one is refused: the same
 * file cannot be a seam and a module of the fork's own. Every seam Sunrise
 * ships has those rows, so this is what refuses a fork naming one of them,
 * for as long as the fork keeps the rows; it is a check against a mistake,
 * not against a fork that edits the lists.
 */
export function ownModuleProblems(
  ownModules: readonly string[],
  onDisk: readonly string[],
  rowsIn: Readonly<Record<string, readonly string[]>>
): string[] {
  const problems: string[] = [];
  for (const entry of ownModules) {
    const name = entry.replace(/^lib\/app\//, '').replace(/\/$/, '');
    if (!/^lib\/app\/[^/]+\/?$/.test(entry)) {
      problems.push(`${entry}: not lib/app/<file> or lib/app/<dir>/`);
    } else if (NOT_A_SEAM.some((rx) => rx.test(name))) {
      problems.push(`${entry}: already not a seam (NOT_A_SEAM), so there is nothing to declare`);
    } else if (entry === OWN_MODULES_FILE) {
      problems.push(`${entry}: the declaration file is a seam, not a module of the fork's own`);
    } else if (!onDisk.includes(entry)) {
      problems.push(
        `${entry}: not in lib/app/ (a directory needs its trailing slash, a file none)`
      );
    } else {
      for (const [list, rows] of Object.entries(rowsIn)) {
        if (rows.includes(entry)) {
          problems.push(
            `${entry}: ${list} still has a row for it. If it is a Sunrise seam, drop the entry; if it is your own module, delete the row`
          );
        }
      }
    }
  }
  return problems;
}
