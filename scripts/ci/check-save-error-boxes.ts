/**
 * Hand-drawn save-error boxes check: CLI.
 *
 * The rules, and why this is needed at all, live in
 * `scripts/ci/save-error-boxes.ts`. This file only walks `components/` and
 * `app/` and hands file contents over.
 *
 * Whole tree, every time, for the reason `check-router-mocks.ts` gives: the
 * invariant holds at zero, so a whole-tree count is the check, and a
 * diff-scoped one would be blind to a box someone re-touches without adding.
 *
 * Usage:
 *   npm run check:save-errors
 */

import { readdirSync, readFileSync } from 'fs';
import { posix, sep } from 'path';

import {
  applyExemptions,
  formatBox,
  scanSaveErrorBoxes,
  type SaveErrorBox,
} from '@/scripts/ci/save-error-boxes';

/** Where components that submit live. */
const ROOTS = ['components', 'app'];

/** Every `.tsx` under the roots, repo-relative, in sorted order. */
export function listComponentSources(root = process.cwd()): string[] {
  return ROOTS.flatMap((dir) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(posix.join(root, dir), { recursive: true, encoding: 'utf8' });
    } catch {
      return [];
    }
    return entries
      .map((entry) => entry.split(sep).join('/'))
      .filter((entry) => entry.endsWith('.tsx'))
      .map((entry) => posix.join(dir, entry));
  }).sort();
}

export function main(root = process.cwd()): number {
  const files = listComponentSources(root);

  // Zero files means the check did not look, not that the tree is clean.
  if (files.length === 0) {
    console.error(`Found no .tsx files under ${ROOTS.join('/, ')}/. Is this the repo root?`);
    console.error(`Looked under ${root}.`);
    return 1;
  }

  const found: SaveErrorBox[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(posix.join(root, file), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EISDIR') continue;
      // "I could not look" is not "there is nothing there".
      unreadable.push(file);
      continue;
    }
    found.push(...scanSaveErrorBoxes(source, file));
  }

  const { boxes, staleExemptions } = applyExemptions(found);

  if (unreadable.length > 0) {
    console.error('Could not read:');
    for (const file of unreadable) console.error(`  ${file}`);
  }

  if (staleExemptions.length > 0) {
    console.error('Exemptions that no longer match a box (remove them from BOX_EXEMPTIONS):');
    for (const key of staleExemptions) console.error(`  ${key}`);
  }

  if (boxes.length > 0) {
    console.error(`Hand-drawn save-error boxes found (${boxes.length}):`);
    for (const box of boxes) console.error(`  ${formatBox(box)}`);
    console.error('');
    console.error(
      'Show a failed save with <SaveError> from @/components/forms/form-error, fed by ' +
        'useSaveFailure(), beside the button that was pressed:'
    );
    console.error('  const save = useSaveFailure({ fallback: "Could not save. Try again." });');
    console.error('  <SaveError failure={save.failure} />');
    console.error('');
    console.error(
      'Not a save (a run, a test, an export)? Put {/* save-error-box-ignore: <why> */} on the ' +
        'line above the box (// save-error-box-ignore: <why> inside parentheses; a fork does ' +
        'this), or add `path#state` to BOX_EXEMPTIONS in scripts/ci/save-error-boxes.ts with ' +
        'the reason. See .context/ui/form-errors.md.'
    );
  }

  if (boxes.length > 0 || staleExemptions.length > 0 || unreadable.length > 0) return 1;

  console.log(`Save-error boxes OK (${files.length} files under ${ROOTS.join('/, ')}/ scanned).`);
  return 0;
}

// `process.exitCode`, not `process.exit()`: stderr to a pipe is asynchronous.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-save-error-boxes.ts')) {
  process.exitCode = main();
}
