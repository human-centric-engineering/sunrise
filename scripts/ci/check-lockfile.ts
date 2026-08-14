/**
 * `package-lock.json` inspection — CLI.
 *
 * Reports what moved between the base revision and this one, and exits
 * non-zero only for the changes that need a human decision (see
 * {@link hasRisk}). A direct downgrade is reported but does NOT gate — see
 * `directDowngrades` in `lockfile-diff.ts` for the measurement behind that.
 * Run by `/pre-pr` when the lockfile is in the diff.
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
  directDowngrades,
  hasRisk,
  type Lockfile,
  type Manifest,
} from '@/scripts/ci/lockfile-diff';

const LOCKFILE = 'package-lock.json';
const MANIFEST = 'package.json';

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

  if (requested.present && requested.ref.startsWith('-')) {
    // `git show <rev>:<path>` cannot take a `--` separator — the spec after it
    // is read as a pathspec, not a revision (tried it; both checks returned
    // nothing). So the ref is validated instead: a leading dash would be
    // parsed as a git option.
    console.error(`\`--base\` must be a revision, not an option: "${requested.ref}".`);
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

  // The head manifest comes from the working tree, not the base: a dependency
  // added in this very PR is direct here even though the base never named it.
  let headManifest: Manifest | null = null;
  try {
    headManifest = JSON.parse(readFileSync(resolve(process.cwd(), MANIFEST), 'utf8')) as Manifest;
  } catch {
    // Every downgrade then reads as transitive, which under-reports. Said out
    // loud — and, critically, the overrides comparison is DISABLED rather than
    // run against `undefined`: leaving it on made a missing manifest exit 1
    // claiming `"overrides" changed`, which is a true failure with an entirely
    // invented cause.
    console.error(
      `Note: could not read ${MANIFEST} — treating every downgrade as transitive, and skipping the overrides comparison.`
    );
  }

  // `overrides` lives here, not in the lockfile — npm never writes the key
  // there. Comparing the lockfile's made the rule unfireable.
  let baseManifest: Manifest | null = null;
  const baseManifestSource = base ? git(['show', `${base}:${MANIFEST}`]) : null;
  if (baseManifestSource === null) {
    console.error(
      `Note: could not read ${MANIFEST} at ${base} — skipping the overrides comparison.`
    );
  } else {
    try {
      baseManifest = JSON.parse(baseManifestSource) as Manifest;
    } catch {
      console.error(
        `Note: could not parse ${MANIFEST} at ${base} — skipping the overrides comparison.`
      );
    }
  }

  // Only compare when BOTH sides were read. One side missing is not evidence
  // that overrides changed; it is evidence that we cannot tell.
  const canCompareOverrides = headManifest !== null && baseManifest !== null;

  const diff = diffLockfiles(baseLock, head, {
    directDependencies: directDependencyKeys(headManifest ?? {}),
    ...(canCompareOverrides
      ? { baseOverrides: baseManifest?.overrides, headOverrides: headManifest?.overrides }
      : {}),
  });

  // Every field, including lost metadata. Leaving that one out made the
  // headline case — d5b913fb, where 77 packages lost `libc` and not one
  // version moved — report "unchanged" and exit 0. The rules had it right and
  // the reporting put the blindfold back on.
  const nothingMoved =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.lostNativeMetadata.length === 0 &&
    diff.gainedNativeMetadata.length === 0 &&
    !diff.overridesChanged;

  if (nothingMoved) {
    // Not "unchanged": these rules read the package key set, `version`, and
    // `libc`/`os`/`cpu`. They do not read `dev`, `resolved`, `integrity` or
    // `link` — this lockfile carries 460 `dev` flags and 1531 integrity
    // hashes. Moving a package between `dependencies` and `devDependencies`
    // flips `dev` across a whole subtree with no version change, which is a
    // real change to the production graph and invisible here. Say what was
    // actually compared.
    console.log(`${LOCKFILE}: no version or platform-metadata change vs ${base}.`);
    return 0;
  }

  console.log(
    `${LOCKFILE} vs ${base}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`
  );
  for (const name of diff.added) console.log(`  + ${name}`);
  for (const name of diff.removed) console.log(`  - ${name}`);
  for (const change of diff.changed) {
    // `packages[""]` is the project itself; printing `~  0.8.0 → 0.8.1` with a
    // blank name shows up on every release PR.
    const label = change.name === '' ? '(this project)' : change.name;
    const note = change.downgrade
      ? change.direct
        ? '  ← DOWNGRADE (direct)'
        : '  ← downgrade'
      : '';
    console.log(`  ~ ${label} ${change.from} → ${change.to}${note}`);
  }

  // Grouped by the exact key set, not a union across all of them. Pairing one
  // count with the union reads as "all N gained all of these": 100 packages
  // gaining `libc` and one gaining `cpu` printed "101 package(s) gained cpu,
  // libc". This hunk exists because the previous output made a true statement
  // misleading; the replacement should not do the same thing.
  const gainedByKeys = new Map<string, number>();
  for (const entry of diff.gainedNativeMetadata) {
    const label = entry.keys.join(', ');
    gainedByKeys.set(label, (gainedByKeys.get(label) ?? 0) + 1);
  }
  for (const [label, count] of [...gainedByKeys].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${count} package(s) gained ${label} — platform metadata restored.`);
  }

  // Direct downgrades are reported in their own block and do NOT gate. They
  // used to; see `directDowngrades` in `lockfile-diff.ts` for the measurement
  // that changed it. The block is deliberately prominent, because on a private
  // fork `dependency-review` is skipped and this is the only per-PR sight of it.
  const downgrades = directDowngrades(diff);
  if (downgrades.length > 0) {
    console.log('');
    console.log(`${downgrades.length} direct dependency(ies) moved BACKWARDS:`);
    for (const change of downgrades) {
      console.log(`  ${change.name} ${change.from} → ${change.to}`);
    }
    console.log('  Not a failure — `dependency-review` fails a PR that lands on a KNOWN');
    console.log('  vulnerable version, which is the actual risk. On a PRIVATE fork that');
    console.log('  action is skipped, so check this one yourself.');
  }

  if (!hasRisk(diff)) {
    const transitive = diff.changed.filter((c) => c.downgrade && !c.direct).length;
    console.log('');
    console.log(
      `Nothing needing a decision: no lost platform metadata and no override change` +
        `${transitive > 0 ? ` (${transitive} transitive downgrade${transitive === 1 ? '' : 's'}, listed above)` : ''}.`
    );
    return 0;
  }

  console.error('');
  console.error(`${LOCKFILE} needs a decision:`);

  for (const lost of diff.lostNativeMetadata) {
    console.error(`  ${lost.name} lost ${lost.keys.join(', ')}`);
  }
  if (diff.lostNativeMetadata.length > 0) {
    console.error('  → npm below 11.11.0 deletes `libc` from every entry it writes, on every');
    console.error('    platform — check `npm -v`. The lockfile will install fine locally and');
    console.error('    wrong on Alpine. Repair with `npm run fix:lockfile-libc`; background in');
    console.error('    CONTRIBUTING.md, "Cutting a release that changes dependencies".');
  }

  for (const change of diff.overrideChanges) {
    const from = change.from ?? 'none';
    const to = change.to ?? 'none';
    console.error(`  ${MANIFEST} "overrides" changed: ${change.key} ${from} → ${to}`);
    console.error('    An override forces a package past a range its dependents declared —');
    console.error('    and REMOVING one can walk a patched transitive back to a vulnerable');
    console.error('    version. Intentional?');
  }

  return 1;
}

process.exitCode = main(process.argv.slice(2));
