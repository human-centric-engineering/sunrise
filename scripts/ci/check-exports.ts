/**
 * Public-surface change detection — CLI.
 *
 * Compares what every `lib/**\/index.ts` barrel exports against the base
 * revision and reports any symbol added, removed or renamed. Run by `/pre-pr`
 * so step 5d's CHANGELOG question is answered by the surface rather than by a
 * path list that will always lag the codebase.
 *
 * This **reports**; it does not gate. Adding an export is normal and correct —
 * the point is that the person writing the PR is asked the CHANGELOG question
 * rather than having to remember to ask it. Exit code is 0 unless something
 * went wrong reading the revisions.
 *
 * The rules, and why the compiler rather than a regex, live in
 * `scripts/ci/exports-diff.ts`.
 *
 * Usage:
 *   npm run check:exports
 *   npx tsx scripts/ci/check-exports.ts --base origin/main
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';

import { diffExports, readBarrelExports, type BarrelExports } from '@/scripts/ci/exports-diff';

const BARREL_GLOB = 'lib/**/index.ts';

let lastGitError = '';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
    lastGitError = (
      typeof stderr === 'string' && stderr.trim() !== ''
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error)
    )
      .split('\n')[0]
      .trim();
    return null;
  }
}

/** `--base <ref>` or `--base=<ref>`; presence tracked so an empty value fails. */
export function parseBaseRef(argv: string[]): { present: boolean; ref: string } {
  const index = argv.indexOf('--base');
  if (index !== -1) return { present: true, ref: argv[index + 1] ?? '' };
  const inline = argv.find((arg) => arg.startsWith('--base='));
  if (inline !== undefined) return { present: true, ref: inline.slice('--base='.length) };
  return { present: false, ref: '' };
}

/**
 * Reads every barrel from the **working tree**, uncommitted changes included.
 *
 * That is the whole point of a pre-PR gate: `git show HEAD:…` would miss the
 * export you just wrote and have not committed, which is precisely when you
 * want to be asked the CHANGELOG question.
 */
export function readBarrelsFromDisk(root = process.cwd()): BarrelExports[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(posix.join(root, 'lib'), { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const files = entries
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => entry === 'index.ts' || entry.endsWith('/index.ts'))
    .map((entry) => posix.join('lib', entry))
    .sort();

  const read = (path: string): string | null => {
    try {
      return readFileSync(posix.join(root, path), 'utf8');
    } catch {
      return null;
    }
  };

  return files.map((file) => {
    const dir = posix.dirname(file);
    const { symbols } = readBarrelExports(read(file) ?? '', (specifier) => {
      if (!specifier.startsWith('.')) return null;
      const base = posix.normalize(posix.join(dir, specifier));
      return read(`${base}.ts`) ?? read(posix.join(base, 'index.ts'));
    });
    return { file, symbols };
  });
}

/** Reads every barrel at a git revision, following `export *` within it. */
export function readBarrelsAt(ref: string): BarrelExports[] | null {
  const listing = git(['ls-tree', '-r', '--name-only', ref, '--', 'lib']);
  if (listing === null) return null;

  const files = listing
    .split('\n')
    .filter((path) => path.endsWith('/index.ts') || path === 'lib/index.ts')
    .sort();

  const sourceOf = (path: string): string | null => git(['show', `${ref}:${path}`]);

  return files.map((file) => {
    const text = sourceOf(file) ?? '';
    const dir = posix.dirname(file);
    const { symbols } = readBarrelExports(text, (specifier) => {
      if (!specifier.startsWith('.')) return null;
      const base = posix.normalize(posix.join(dir, specifier));
      // `./x` may be `x.ts` or `x/index.ts`; try both, as the compiler would.
      return sourceOf(`${base}.ts`) ?? sourceOf(posix.join(base, 'index.ts'));
    });
    return { file, symbols };
  });
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(argv: string[]): number {
  const requested = parseBaseRef(argv);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    return 1;
  }

  const base = requested.present
    ? requested.ref
    : git(['merge-base', 'origin/main', 'HEAD'])?.trim();

  if (!base) {
    console.log(`${BARREL_GLOB}: no base revision available — skipped.`);
    return 0;
  }

  const baseBarrels = readBarrelsAt(base);
  if (baseBarrels === null) {
    if (requested.present) {
      console.error(`Could not read barrels at "${requested.ref}".`);
      console.error(`git: ${lastGitError}`);
      return 1;
    }
    console.log(`${BARREL_GLOB}: base revision unreadable — skipped.`);
    return 0;
  }

  const headBarrels = readBarrelsFromDisk();
  const changes = diffExports(baseBarrels, headBarrels);

  if (changes.length === 0) {
    console.log(`No barrel exports changed vs ${base} (${headBarrels.length} barrels).`);
    return 0;
  }

  console.log(`Public surface changed vs ${base}:`);
  for (const change of changes) {
    console.log(`  ${change.file}`);
    for (const name of change.added) console.log(`    + ${name}`);
    for (const name of change.removed) console.log(`    - ${name}`);
  }
  console.log('');
  console.log('These are symbols a fork can import. A CHANGELOG entry under');
  console.log('`## [Unreleased]` is probably warranted — see VERSIONING.md.');
  console.log('Removals and renames are breaking for anyone importing them.');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
