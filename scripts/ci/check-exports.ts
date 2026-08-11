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
import { posix, resolve, sep } from 'node:path';

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

/**
 * Turns an import specifier into repo-relative candidate paths and reads the
 * first that exists.
 *
 * **`@/` is not optional here.** CLAUDE.md mandates the alias and ESLint's
 * `no-restricted-imports` forbids relative paths, so every `export *` in `lib/`
 * is an `@/` specifier — all six of them. An earlier version accepted only
 * `./`, which meant it followed no stars at all in the one codebase it runs on,
 * while its own header claimed following them was the reason it used the
 * TypeScript compiler.
 */
export function resolveSpecifier(
  specifier: string,
  fromDir: string,
  read: (path: string) => string | null
): { text: string; dir: string } | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = posix.normalize(specifier.slice('@/'.length));
  } else if (specifier.startsWith('.')) {
    base = posix.normalize(posix.join(fromDir, specifier));
  } else {
    // A bare specifier is a node_modules package; not our surface.
    return null;
  }

  // `x` may be `x.ts` or `x/index.ts`; try both, as the compiler would. The
  // directory returned is the one the resolved FILE sits in, so a star it
  // writes resolves relative to itself rather than to whoever imported it.
  const asFile = read(`${base}.ts`);
  if (asFile !== null) return { text: asFile, dir: posix.dirname(`${base}.ts`) };

  const asIndex = read(posix.join(base, 'index.ts'));
  if (asIndex !== null) return { text: asIndex, dir: base };

  return null;
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

  // Clamped to the root. `posix.normalize` collapses `..` but does not stop it,
  // so `export * from '../../../elsewhere/x'` in a barrel resolved above the
  // repo and was read. Only symbol names ever reach the output, so nothing
  // leaks a file's contents — but `/pre-pr` asks for that output to be recorded
  // in a PR summary, and identifier names from a private sibling checkout are
  // not ours to print. The sibling scripts read fixed paths and never had this
  // surface; this one should not either.
  const rootPrefix = resolve(root) + sep;
  const read = (path: string): string | null => {
    const full = resolve(root, path);
    if (full !== resolve(root) && !full.startsWith(rootPrefix)) return null;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };

  return files.map((file) => {
    const dir = posix.dirname(file);
    const source = read(file);
    // An unreadable barrel is not an empty one. `?? ''` made it read as a
    // wholesale removal (or addition) with no warning — the same "no symbols
    // vs could not look" conflation this module rejects for stars, one level
    // up. Recorded as an unresolved star against itself so it is reported.
    if (source === null) return { file, symbols: [], unresolvedStars: [file] };
    const { symbols, unresolvedStars } = readBarrelExports(
      source,
      (specifier, from) => resolveSpecifier(specifier, from, read),
      dir
    );
    return { file, symbols, unresolvedStars };
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
    const text = sourceOf(file);
    const dir = posix.dirname(file);
    if (text === null) return { file, symbols: [], unresolvedStars: [file] };
    const { symbols, unresolvedStars } = readBarrelExports(
      text,
      (specifier, from) => resolveSpecifier(specifier, from, (path) => sourceOf(path)),
      dir
    );
    return { file, symbols, unresolvedStars };
  });
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(argv: string[]): number {
  const requested = parseBaseRef(argv);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
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

  // Both sides empty means the check did not look, not that nothing changed.
  // Run from `app/` rather than the repo root, `git ls-tree -- lib` matches
  // nothing and `readdirSync(cwd/lib)` throws, so this printed a clean bill and
  // exited 0 with `(0 barrels)` as the only tell. The sibling lockfile check
  // fails loudly in the same situation; so should this one.
  if (baseBarrels.length === 0 && headBarrels.length === 0) {
    console.error('Found no barrels on either revision — is this the repo root?');
    console.error(`Looked for \`lib/**/index.ts\` under ${process.cwd()}.`);
    return 1;
  }
  // "No symbols" and "could not look" must not arrive as the same answer —
  // `exports-diff.ts` says so, and then both call sites here destructured only
  // `symbols` and threw this away. That silence is what let a resolver which
  // followed none of this repo's stars look like a clean report.
  // BOTH sides. A star unfollowed on the base makes the comparison just as
  // incomplete as one unfollowed here — every symbol behind it reads as newly
  // added. Checking only head was the first version, and the test written for
  // this very message is what caught it.
  const unresolved = [
    ...baseBarrels.map((barrel) => ({ side: base, barrel })),
    ...headBarrels.map((barrel) => ({ side: 'working tree', barrel })),
  ].filter((entry) => entry.barrel.unresolvedStars.length > 0);

  if (unresolved.length > 0) {
    console.error('Could not follow every `export *`, so this comparison is incomplete:');
    for (const { side, barrel } of unresolved) {
      for (const specifier of barrel.unresolvedStars) {
        console.error(`  ${barrel.file} → ${specifier}  (at ${side})`);
      }
    }
    console.error('');
  }

  // A barrel we could not read is excluded from the comparison entirely. Left
  // in, it carries `symbols: []`, so `diffExports` reports everything it used
  // to export as removed — a confident, fabricated breaking-change list under
  // the "removals are breaking for anyone importing them" footer. The warning
  // above already says we could not look.
  const unreadable = new Set(
    unresolved
      .filter(({ barrel }) => barrel.unresolvedStars.includes(barrel.file))
      .map(({ barrel }) => barrel.file)
  );
  const changes = diffExports(
    baseBarrels.filter((barrel) => !unreadable.has(barrel.file)),
    headBarrels.filter((barrel) => !unreadable.has(barrel.file))
  );

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
