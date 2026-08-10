/**
 * `package-lock.json` inspection — CLI.
 *
 * Reports what moved between the base revision and this one, and exits
 * non-zero only for the changes that need a human decision (see
 * {@link hasRisk}). Run by `/pre-pr` when the lockfile is in the diff.
 *
 * The rules, and why each exists, live in `scripts/ci/lockfile-diff.ts`.
 *
 * Usage:
 *   npm run check:lockfile                    # vs the merge base with origin/main
 *   npx tsx scripts/ci/check-lockfile.ts --base origin/main
 *
 * Base resolution matches `check-changelog.ts` deliberately: `--base <ref>`
 * treats an unreadable ref as a hard failure, and with no flag it falls back to
 * the merge base with `origin/main` and skips quietly when that is unavailable.
 * A fresh clone with no remote must not fail the run.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  diffLockfiles,
  directDependencyKeys,
  hasRisk,
  type Lockfile,
} from '@/scripts/ci/lockfile-diff';

const LOCKFILE = 'package-lock.json';

/** git's own first line of complaint, falling back to the thrown message. */
function describeGitFailure(error: unknown): string {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
  const text =
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.split('\n')[0].trim();
}

let lastGitError = '';

/** Runs git, returning `null` for any failure — missing repo, ref, or file. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A lockfile is megabytes; Node's 1 MiB default would throw on the
      // `git show` and the failure would read as a missing ref.
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    lastGitError = describeGitFailure(error);
    return null;
  }
}

/** `--base <ref>` or `--base=<ref>`; `present` is tracked separately so an
 * empty value fails loudly rather than degrading to a silent skip. */
export function parseBaseRef(argv: string[]): { present: boolean; ref: string } {
  const index = argv.indexOf('--base');
  if (index !== -1) return { present: true, ref: argv[index + 1] ?? '' };
  const inline = argv.find((arg) => arg.startsWith('--base='));
  if (inline !== undefined) return { present: true, ref: inline.slice('--base='.length) };
  return { present: false, ref: '' };
}

/** Parses a lockfile, or returns null with the reason printed. */
function parseLockfile(source: string, label: string): Lockfile | null {
  try {
    return JSON.parse(source) as Lockfile;
  } catch (error) {
    console.error(`Could not parse ${LOCKFILE} at ${label}`);
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(argv: string[]): number {
  const requested = parseBaseRef(argv);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    console.error('Omit the flag entirely to fall back to the merge base with origin/main.');
    return 1;
  }

  let headSource: string;
  try {
    headSource = readFileSync(resolve(process.cwd(), LOCKFILE), 'utf8');
  } catch (error) {
    console.error(`Could not read ${LOCKFILE}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const base = requested.present
    ? requested.ref
    : git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  const baseSource = base ? git(['show', `${base}:${LOCKFILE}`]) : null;

  if (baseSource === null) {
    if (requested.present) {
      console.error(`Could not read ${LOCKFILE} at "${requested.ref}".`);
      console.error(`git: ${lastGitError}`);
      return 1;
    }
    console.log(`${LOCKFILE}: no base revision available — skipped.`);
    return 0;
  }

  const head = parseLockfile(headSource, 'HEAD');
  const baseLock = parseLockfile(baseSource, base ?? 'the base revision');
  if (!head || !baseLock) return 1;

  // Read from the working tree, not the base: a dependency added in this very
  // PR is direct here even though the base never named it.
  let direct = new Set<string>();
  try {
    direct = directDependencyKeys(
      JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }
    );
  } catch {
    // No manifest, or unreadable: every downgrade then reads as transitive,
    // which under-reports rather than over-reports. Said out loud below.
    console.error('Note: could not read package.json — treating every downgrade as transitive.');
  }

  const diff = diffLockfiles(baseLock, head, direct);

  // Every field, including lost metadata. Leaving that one out made the
  // headline case — d5b913fb, where 77 packages lost `libc` and not one
  // version moved — report "unchanged" and exit 0. The rules had it right and
  // the reporting put the blindfold back on.
  const nothingMoved =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.lostNativeMetadata.length === 0 &&
    !diff.overridesChanged;

  if (nothingMoved) {
    console.log(`${LOCKFILE} unchanged vs ${base}.`);
    return 0;
  }

  console.log(
    `${LOCKFILE} vs ${base}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`
  );
  for (const name of diff.added) console.log(`  + ${name}`);
  for (const name of diff.removed) console.log(`  - ${name}`);
  for (const change of diff.changed) {
    const note = change.downgrade
      ? change.direct
        ? '  ← DOWNGRADE (direct)'
        : '  ← downgrade'
      : '';
    console.log(`  ~ ${change.name} ${change.from} → ${change.to}${note}`);
  }

  if (!hasRisk(diff)) {
    const transitive = diff.changed.filter((c) => c.downgrade).length;
    console.log('');
    console.log(
      `Nothing needing a decision: no lost platform metadata, no override change, and no` +
        ` direct dependency moved backwards${transitive > 0 ? ` (${transitive} transitive downgrade${transitive === 1 ? '' : 's'}, listed above)` : ''}.`
    );
    return 0;
  }

  console.error('');
  console.error(`${LOCKFILE} needs a decision:`);

  for (const lost of diff.lostNativeMetadata) {
    console.error(`  ${lost.name} lost ${lost.keys.join(', ')}`);
  }
  if (diff.lostNativeMetadata.length > 0) {
    console.error(
      '  → npm dropped platform metadata, which happens when the tree is recomputed on macOS.'
    );
    console.error(
      '    The lockfile will install fine locally and wrong on Linux. See CONTRIBUTING.md,'
    );
    console.error('    "Cutting a release that changes dependencies".');
  }

  for (const change of diff.changed.filter((entry) => entry.downgrade && entry.direct)) {
    console.error(`  ${change.name} went BACKWARDS: ${change.from} → ${change.to}`);
    console.error('    A direct dependency losing ground is how a patched package returns to a');
    console.error('    vulnerable one. Intentional pin, or an accident of recomputing the tree?');
  }
  if (diff.overridesChanged) {
    console.error('  package.json "overrides" changed — that forces a package past a range its');
    console.error('    dependents declared. Intentional?');
  }

  return 1;
}

process.exitCode = main(process.argv.slice(2));
