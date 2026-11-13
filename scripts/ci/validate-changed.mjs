// Lint and format only what this branch changed: the scoped half of
// `npm run validate:changed`.
//
// WHY THIS EXISTS
// `npm run validate` runs seven steps over the whole tree, and two of them scale
// with the size of the repository rather than the size of the change: type-aware
// ESLint (`eslint .`, the job `run-capped.mjs` exists to keep inside the heap)
// and `prettier --check .`. `/pre-pr` runs after every review fix, so a two-file
// fix paid to lint and format every file in the tree each time — on a large fork
// that is minutes per loop, and a cold run can abort with exit 134 (#863). Tests
// already had a scoped path (`test:changed`); validate had none.
//
// WHAT IS NOT SCOPED, DELIBERATELY
// `tsc --noEmit`. Type-checking is whole-program: handing `tsc` a file list
// drops the project config and stops it checking the CONSUMERS of what changed,
// which are the errors worth catching. `validate:changed` runs the full
// type-check and every other `validate` step unchanged; only lint and Prettier
// are swapped for this script, so nothing is dropped.
//
// THE LIMIT IT CANNOT REMOVE. A type-aware rule can fire in an UNCHANGED file
// because a changed file's types moved (an export becoming `any` trips
// `no-unsafe-*` in its callers). A change-scoped lint cannot see that. CI's
// `Lint & format` job lints the whole tree on every PR and stays the backstop,
// so the cost is finding out on the PR rather than locally. Nothing ships
// without the check.
//
// WHEN IT GOES WHOLE-TREE BY ITSELF. Some changes alter results in files the
// branch never touched, and for those a diff filter lints the wrong set — often
// nothing. `chunked-lint.mjs` names the sharpest case: a `typescript-eslint`
// bump touches only the lockfile, so a diff filter lints nothing while the whole
// risk of the bump is that it changes results everywhere. So a change to a lint
// or format config, a root tsconfig or the lockfile runs that tool over the
// whole tree, and says why (`LINT_WIDENERS`, `FORMAT_WIDENERS`).
//
// WHAT COUNTS AS CHANGED
// The branch diff against `git merge-base origin/main HEAD` (or `--base <ref>`),
// plus everything uncommitted — staged, unstaged and untracked. The uncommitted
// half is not an extra: this runs mid-gate, where review fixes sit in the
// working tree, and a gate that could not see them would report clean on code
// nobody checked. Deleted paths are dropped by existence.
//
// IT FAILS CLOSED. A base it cannot resolve, or a `git` listing that fails,
// exits 1. The uncommitted listings alone would return a plausible handful of
// files, and a run that checked a fraction of the branch would print the same
// "clean" as a real one — `.context/architecture/checks.md`'s "I could not look"
// reported as "I found nothing".
//
// LINT GOES THROUGH `chunked-lint.mjs`'s `main`, scoped or whole-tree, so the
// fork's `CI_LINT_CHUNKS` / `LINT_CHUNKS` applies here too. A fork that needs
// chunks to keep a whole-tree lint inside the heap would otherwise abort with
// 134 on every lockfile bump, which is exactly when this widens.
//
// PLAIN .mjs, NO BUILD STEP — same rule as `chunked-lint.mjs` and
// `run-capped.mjs`, and for a second reason: it reuses `chunked-lint.mjs`'s
// ESLint runner (heap cap, chunking, `--` before filenames, `shell: false`,
// signal exit codes) instead of restating it, and a `.ts` script run by `tsx` is CommonJS,
// which cannot import an ES module with top-level `await`.
//
// Exit codes: 0 — both tools clean, or nothing in scope. 1 or the tool's own
// code (134 for a heap abort) — a tool reported a problem, or the check could
// not establish what changed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

import { LINTABLE, ROOT, main as chunkedLint } from './chunked-lint.mjs';

/**
 * The ESLint flags `npm run lint` passes, so this path and a whole-tree lint
 * share one `.eslintcache` instead of each paying its own cold run.
 *
 * Keep this in step with `lint` in `package.json`. ESLint deletes the cache
 * when run WITHOUT `--cache`, so a stray bare `npx eslint <file>` makes the
 * next whole-tree run cold (#863) — which is why every caller passes it.
 */
export const ESLINT_ARGS = ['--cache', '--cache-strategy', 'content'];

/**
 * The Prettier flags `npm run format:check` passes, plus `--ignore-unknown`.
 *
 * `prettier --check .` walks the tree and silently skips a file it has no
 * parser for. A file named EXPLICITLY with no inferable parser (`Dockerfile`,
 * `.nvmrc`, a `.husky/` hook, a shell script) is a hard error instead, and this
 * script names files explicitly. `--ignore-unknown` restores the walk's
 * behaviour, so the scoped set is exactly the files `format:check` would have
 * checked, with no extension list here to fall behind Prettier's. Files in
 * `.prettierignore` are skipped even when named, as in the walk.
 */
export const PRETTIER_ARGS = [
  '--check',
  '--ignore-unknown',
  '--cache',
  '--cache-strategy',
  'content',
  '--cache-location',
  '.prettiercache',
];

/**
 * Changed paths that make ESLint's results in UNCHANGED files move, so the
 * lint runs whole-tree.
 *
 * - any `eslint.config.*` — the root config, the fork tier's
 *   `lib/app/eslint.config.mjs`, or a framework tier's;
 * - a root `tsconfig*.json` — type-aware rules read the program it defines;
 * - `package-lock.json` — a plugin or parser bump changes results everywhere,
 *   and ESLint invalidates its whole cache when a plugin version changes.
 *
 * `package.json` is not here: an edit that changes no installed version (a new
 * script) changes no lint result, and one that does also changes the lockfile.
 */
export const LINT_WIDENERS = [
  /(^|\/)eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/,
  /^tsconfig[^/]*\.json$/,
  /^package-lock\.json$/,
];

/**
 * As {@link LINT_WIDENERS}, for Prettier: a config at any depth (Prettier
 * resolves the nearest one per file), `.editorconfig` (the CLI reads it by
 * default), its ignore file, or a version bump.
 */
export const FORMAT_WIDENERS = [
  /(^|\/)\.prettierrc/,
  /(^|\/)prettier\.config\./,
  /(^|\/)\.editorconfig$/,
  /^\.prettierignore$/,
  /^package-lock\.json$/,
];

/**
 * Files per Prettier process. A branch carrying a merge from upstream can
 * change thousands of files, and one argv holding them all can exceed the OS
 * argument limit (E2BIG), which surfaces as "Failed to start prettier" — a
 * tool failure reported as a format failure.
 */
export const PRETTIER_BATCH = 500;

/**
 * Split a NUL-delimited git listing. On NUL only, untrimmed: `-z` exists so a
 * path containing a newline or leading space arrives verbatim (see
 * `chunked-lint.mjs` `lintTargets`).
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function splitNul(raw) {
  return raw.split('\0').filter((entry) => entry !== '');
}

/**
 * Run git and return stdout, or `null` when it fails — the caller treats any
 * `null` as "could not look", never as "nothing changed".
 *
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function runGit(args) {
  const out = spawnSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.status === 0 ? out.stdout : null;
}

/**
 * The base revision: `--base <ref>` or `--base=<ref>` when given, otherwise
 * the merge base with `origin/main` (the base `test:changed` and
 * `check:missing-tests` use).
 *
 * Any other argument is an error, not ignored: a mistyped flag silently falling
 * back to `origin/main` would check a different file set from the one asked
 * for and still report clean.
 *
 * @param {readonly string[]} argv
 * @param {(args: readonly string[]) => string | null} git
 * @returns {{ base: string } | { error: string }}
 */
export function resolveBase(argv, git) {
  /** @type {string | undefined} */
  let ref;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: '`--base` needs a revision.' };
      ref = value;
    } else if (arg.startsWith('--base=')) {
      const value = arg.slice('--base='.length);
      if (!value || value.startsWith('-')) return { error: '`--base` needs a revision.' };
      ref = value;
    } else {
      return { error: `unknown argument "${arg}". The only option is \`--base <ref>\`.` };
    }
  }
  if (ref) return { base: ref };
  const base = git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  if (!base) {
    return {
      error:
        'no base revision available. Run `git fetch origin main` and re-run, or pass `--base <ref>`.',
    };
  }
  return { base };
}

/**
 * Every path this branch touched that exists on disk, sorted, or `null` when
 * any listing failed.
 *
 * Every listing is ROOT-relative: `--relative` makes the two diffs match
 * `ls-files`, which is already relative to the cwd (`-C ROOT`), so a checkout
 * whose ROOT is below the git toplevel (a monorepo package) still finds its
 * committed changes on disk.
 *
 * All three listings are required. A failed branch diff (a mistyped `--base`, a
 * base the clone does not have) leaves the uncommitted listings looking like a
 * whole answer, so it has to fail the run rather than shrink it.
 *
 * @param {string} base
 * @param {{ git: (args: readonly string[]) => string | null, exists: (file: string) => boolean }} deps
 * @returns {string[] | null}
 */
export function changedFiles(base, { git, exists }) {
  const listings = [
    // Committed on this branch since it left the base.
    git([
      '-c',
      'core.quotePath=false',
      'diff',
      '--relative',
      '--name-only',
      '-z',
      `${base}...HEAD`,
    ]),
    // Staged and unstaged, in one pass against HEAD.
    git(['-c', 'core.quotePath=false', 'diff', '--relative', '--name-only', '-z', 'HEAD']),
    // New files nobody has `git add`ed yet.
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ];
  if (listings.some((out) => out === null)) return null;
  const found = new Set(listings.flatMap((out) => splitNul(/** @type {string} */ (out))));
  return [...found].filter((file) => exists(file)).sort();
}

/**
 * The first changed path that widens a tool to the whole tree, or `undefined`.
 *
 * @param {readonly string[]} files
 * @param {readonly RegExp[]} wideners
 * @returns {string | undefined}
 */
export function widenedBy(files, wideners) {
  return files.find((file) => wideners.some((pattern) => pattern.test(file)));
}

/**
 * What each tool should check: `{ whole: <path that widened it> }` or
 * `{ files }`.
 *
 * Lint targets are the changed files with an extension the flat config lints
 * (`chunked-lint.mjs`'s `LINTABLE`), minus those ESLint itself ignores. Asking
 * ESLint, not a copy of its `ignores`, is the same choice `lintTargets` makes;
 * and a file named explicitly that the config ignores draws a "File ignored"
 * warning `eslint .` never prints.
 *
 * @param {readonly string[]} files
 * @param {(file: string) => Promise<boolean>} isLintIgnored
 * @returns {Promise<{ lint: { whole: string } | { files: string[] }, format: { whole: string } | { files: string[] } }>}
 */
export async function plan(files, isLintIgnored) {
  const lintWidener = widenedBy(files, LINT_WIDENERS);
  const formatWidener = widenedBy(files, FORMAT_WIDENERS);

  let lint;
  if (lintWidener) {
    lint = { whole: lintWidener };
  } else {
    const candidates = files.filter((file) => LINTABLE.some((ext) => file.endsWith(ext)));
    const ignored = await Promise.all(candidates.map((file) => isLintIgnored(file)));
    lint = { files: candidates.filter((_, i) => !ignored[i]) };
  }

  const format = formatWidener ? { whole: formatWidener } : { files: [...files] };
  return { lint, format };
}

/**
 * Prettier has no `--` terminator, so a changed file named `--write` would be
 * read as a flag. Prefixing `./` makes every argument a path. ESLint gets `--`
 * from `runChunk` instead.
 *
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function asPathArgs(files) {
  return files.map((file) => `./${file}`);
}

/**
 * Split a list into consecutive batches of at most `size`.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * How to show the base in the log: a full SHA shortened, a named ref
 * (`origin/main`, `v0.18.0`) verbatim, since cutting a name hides which base
 * was used.
 *
 * @param {string} base
 * @returns {string}
 */
export function describeBase(base) {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base) ? base.slice(0, 9) : base;
}

/**
 * Run Prettier's JS entry point under `process.execPath` with `shell: false`,
 * for the reason `resolveEslintCommand` gives: the argv is filenames, and a
 * shell would interpret them.
 *
 * @param {readonly string[]} targets
 * @returns {Promise<number>}
 */
export function runPrettier(targets) {
  const entry = join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  return new Promise((resolveCode) => {
    const child = spawn(process.execPath, [entry, ...PRETTIER_ARGS, ...targets], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', (error) => {
      console.error(`Failed to start prettier: ${error.message}`);
      resolveCode(1);
    });
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}

/**
 * @param {readonly string[]} [argv]
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  /** @type {ESLint | undefined} Built on first use: loading the config is not free. */
  let eslint;
  const {
    git = runGit,
    exists = (/** @type {string} */ file) => existsSync(join(ROOT, file)),
    isLintIgnored = (/** @type {string} */ file) => {
      eslint ??= new ESLint({ cwd: ROOT });
      return eslint.isPathIgnored(join(ROOT, file));
    },
    // `undefined` targets: the whole tree, as `chunked-lint` enumerates it.
    lint = (/** @type {string[] | undefined} */ targets) =>
      chunkedLint(ESLINT_ARGS, targets ? { targets } : {}),
    format = runPrettier,
    log = console.log,
    error = console.error,
  } = deps;

  const resolved = resolveBase(argv, git);
  if ('error' in resolved) {
    error(`validate:changed — could not run: ${resolved.error}`);
    return 1;
  }
  const { base } = resolved;

  const files = changedFiles(base, { git, exists });
  if (files === null) {
    error(`validate:changed — could not run: a git listing failed against base "${base}".`);
    error('Check the revision exists (`git fetch origin main` if the local ref is stale).');
    return 1;
  }

  log(
    `validate:changed — ${files.length} changed file${files.length === 1 ? '' : 's'} ` +
      `against ${describeBase(base)}.`
  );

  const { lint: lintPlan, format: formatPlan } = await plan(files, isLintIgnored);
  let worst = 0;

  if ('whole' in lintPlan) {
    log(`ESLint: whole tree, because ${lintPlan.whole} changed.`);
    worst = Math.max(worst, await lint(undefined));
  } else if (lintPlan.files.length > 0) {
    log(`ESLint: ${lintPlan.files.length} file(s).`);
    worst = Math.max(worst, await lint(lintPlan.files));
  } else {
    log('ESLint: nothing in scope.');
  }

  // Prettier runs even when ESLint failed: two reports in one pass beat a
  // re-run to discover the second.
  if ('whole' in formatPlan) {
    log(`Prettier: whole tree, because ${formatPlan.whole} changed.`);
    worst = Math.max(worst, await format(['.']));
  } else if (formatPlan.files.length > 0) {
    log(`Prettier: ${formatPlan.files.length} file(s).`);
    for (const batch of batches(asPathArgs(formatPlan.files), PRETTIER_BATCH)) {
      worst = Math.max(worst, await format(batch));
    }
  } else {
    log('Prettier: nothing in scope.');
  }

  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
