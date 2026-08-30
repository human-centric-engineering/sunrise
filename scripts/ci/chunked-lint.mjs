// Lints the tree as N sequential ESLint processes, one at a time.
//
// WHY THIS EXISTS
// `CI_NODE_HEAP_MB` (Knob 2) raises the ceiling. This is the lever for after
// that one runs out of room, because the ceiling eventually IS the machine:
// a private-fork `ubuntu-latest` is an 8GB box, and `.context/architecture/ci.md`
// already treats ~6GB as the practical maximum, since a cap above physical RAM
// converts a clean V8 abort into an OOM kill.
//
// Base Sunrise is not near that ceiling and does not need chunking — this ships
// unchunked by default (see `DEFAULT_CHUNKS`). It is here for the forks, which
// is where it was measured: a downstream fork of ~4,500 lintable files (roughly
// 2x this tree) peaked at 6.36GB and OOM'd at a 6144 cap on a runner.
//
// THE MEASUREMENT THIS IS BUILT ON — all figures below were taken on THAT fork,
// on a 4-core runner, cold. They are not Sunrise's numbers and are recorded as
// the shape of the cost, not as a prediction for any particular tree:
//
//     files linted   peak RSS
//              1     2.64 GB   <- floor: the TypeScript Program
//            565     3.02 GB
//          1,131     3.50 GB
//          4,525     4.70 GB   <- one whole-tree pass
//
// 56% of the cost is a FLOOR that no amount of splitting removes. Type-aware
// linting needs types for the file under test, types come from the whole
// project graph, so ESLint builds a Program over every file in `tsconfig.json`
// before it lints a line. (For scale: `tsc --noEmit` type-checks that entire
// repo in 2.26GB — ESLint costs MORE to lint one file, because typescript-eslint
// re-materialises TypeScript's AST into ESTree, a second AST per file, and
// ESLint layers scope analysis on that.) The other 44% is marginal per-file
// cost, and that is the part chunking divides.
//
// WHY THIS AND NOT A CHANGED-FILES FILTER. The run that dies is the COLD one,
// and ESLint keys cache entries on the resolved config — so a `typescript-eslint`
// bump invalidates every entry and forces a whole-tree run. That bump touches
// only `package.json` and `package-lock.json`, so a diff filter would lint
// NOTHING, while the entire risk of a linter bump is that it changes results on
// any file. The complete lint has to run *and* fit.
//
// WHY SEQUENTIAL CHUNKS AND NOT A PARALLEL JOB MATRIX. Each chunk is its own
// `eslint` process, so its memory is released when it exits and the job's peak
// is the LARGEST chunk rather than the sum. That is sharding's memory profile
// without sharding's bill: Actions meters per job rounded up to the minute, so
// a matrix of N jobs pays N checkouts and N `npm ci`s — real money on a private
// fork, for setup it throws away. This trades wall-clock instead, which is the
// cheaper currency here.
//
// GETTING THE FILE LIST RIGHT IS THE WHOLE SAFETY PROPERTY. A chunk plan that
// omits files does not fail — it passes, faster, having linted less. An earlier
// draft of this change split by directory name and silently dropped 139 files
// (`emails/`, `hooks/`, `types/`, `prisma/`, `proxy.ts`, every root config)
// while staying green. So the list is derived from ESLint's OWN ignore logic via
// `isPathIgnored` rather than from a roster, and
// `tests/unit/scripts/ci/chunked-lint.test.ts` asserts the chunks partition it
// exactly — every file once, none lost.
//
// PLAIN .mjs, NO BUILD STEP — same rule as `run-capped.mjs` and
// `dev-server.mjs`. It runs from `npm run lint:ci` in a fresh checkout.
//
// NOT ROUTED THROUGH `run-capped.mjs`, deliberately. That wrapper spawns with
// `shell: true` on Windows and quotes only the command, so a caller whose argv
// is filenames hands `cmd.exe` whatever `&` or `^` a path contains — its own
// docblock names this as the reason `lint-staged` calls eslint directly. This
// script's argv IS filenames, so it spawns with `shell: false` and applies the
// heap cap itself (`withHeapCap`), which is the one thing the wrapper would
// otherwise have done for it.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ESLint } from 'eslint';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WINDOWS = process.platform === 'win32';

/** Extensions the flat config has `files` blocks for. */
export const LINTABLE = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];

/**
 * Chunks when nothing asks for a number: ONE, i.e. exactly today's behaviour.
 *
 * This differs from the fork the script was measured on, which defaults to 4,
 * and the difference is the point. Chunking is not free — it pays the ~2.6GB
 * TypeScript Program floor once per chunk, which on that fork took a cold lint
 * from 1m23s to 6m51s. Base Sunrise has never approached its heap ceiling, so
 * upstream should not buy memory headroom it does not need with wall-clock it
 * would rather keep.
 *
 * A fork raises `CI_LINT_CHUNKS` when its lint aborts with exit 134. Measured
 * on that fork at a 6144 cap, cold: 1 chunk 6.36GB (OOM), 2 -> 5.75GB,
 * 4 -> 5.20GB, 6 -> 4.98GB. See `.context/architecture/ci.md` Knob 4.
 */
export const DEFAULT_CHUNKS = 1;

/** Cap applied when the environment carries none. Matches `run-capped.mjs`'s
 * value, and comfortably clears the measured 2.64GB floor. */
export const DEFAULT_HEAP_MB = 6144;

/**
 * Parse `LINT_CHUNKS`. A garbage value falls back rather than failing the run —
 * refusing to lint because an unrelated variable is malformed trades a small
 * problem for a bigger one, the same rule as `run-capped.mjs`'s `NODE_HEAP_MB`.
 *
 * But it falls back LOUDLY, which the fork original did not. There the fallback
 * was 4, so a typo'd knob still chunked and the only cost was the wrong number.
 * Here the fallback is 1 — unchunked — so silence would let a fork that set
 * `CI_LINT_CHUNKS=six` believe it had fixed its OOM and meet the identical
 * failure with nothing in the log connecting the two.
 *
 * @param {string | undefined} raw
 * @param {(message: string) => void} [warn]
 * @returns {number}
 */
export function parseChunks(raw, warn = console.error) {
  if (raw === undefined || raw === '') return DEFAULT_CHUNKS;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  warn(
    `chunked-lint: LINT_CHUNKS="${raw}" is not a positive integer — falling back to ${DEFAULT_CHUNKS} chunk(s). ` +
      `If you set this to fix a lint OOM, it has NOT taken effect.`
  );
  return DEFAULT_CHUNKS;
}

/**
 * Group key for a file at a given depth — its first `depth` path segments.
 *
 * @param {string} file
 * @param {number} depth
 * @returns {string}
 */
export function groupKey(file, depth = 2) {
  const parts = file.split('/');
  if (parts.length <= 1) return '.';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

/**
 * Bucket `items` by directory, deepening any bucket bigger than `target`.
 *
 * A FIXED DEPTH DOES NOT WORK on a tree this shape. At depth 2, `tests/unit`
 * alone was 1,649 of the measured fork's 4,527 files — one indivisible group, so
 * every plan had a chunk more than a third of the tree wide and that chunk set
 * the peak on its own. Deepening only the oversized buckets keeps small
 * directories whole (locality preserved where it is free) while splitting the
 * few that are too big to pack.
 *
 * Terminates because each pass either deepens a bucket or leaves it alone, and a
 * bucket stops deepening once its files have no deeper segment to split on —
 * which is also why a directory of 2,000 sibling files stays one bucket rather
 * than looping forever.
 *
 * @param {readonly string[]} items
 * @param {number} target Desired maximum bucket size.
 * @returns {Map<string, string[]>}
 */
export function adaptiveGroups(items, target) {
  /** @type {Map<string, string[]>} */
  let groups = new Map();
  for (const item of items) {
    const key = groupKey(item, 1);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  for (let depth = 2; depth <= 8; depth++) {
    let split = false;
    /** @type {Map<string, string[]>} */
    const next = new Map();
    for (const [key, files] of groups) {
      // Only deepen a bucket that is both too big AND actually divisible: some
      // file in it must have a segment beyond the current depth.
      const divisible = files.some((f) => f.split('/').length > depth);
      if (files.length > target && divisible) {
        split = true;
        for (const file of files) {
          const k = groupKey(file, depth);
          const bucket = next.get(k);
          if (bucket) bucket.push(file);
          else next.set(k, [file]);
        }
      } else {
        next.set(key, files);
      }
    }
    groups = next;
    if (!split) break;
  }
  return groups;
}

/**
 * Split `items` into at most `count` chunks, KEEPING EACH DIRECTORY TOGETHER.
 *
 * LOCALITY IS THE WHOLE POINT, and the first version of this function got it
 * exactly backwards. It striped files round-robin to balance the chunks, on the
 * theory that no chunk should inherit a heavy import closure. Measured, that
 * made things WORSE than not chunking at all (3.98GB striped against 3.28GB in
 * one pass): striping guarantees every chunk touches every corner of the tree,
 * so every chunk loads nearly the whole type graph and each one pays close to
 * the full cost.
 *
 * What a chunk actually costs is its IMPORT CLOSURE, not its file count.
 * `eslint prisma` — 98 files — peaks at 1.92GB, while a single file in `lib/api`
 * peaks at 2.64GB, because the second reaches most of the app and the first does
 * not. So chunks are built from whole directories, and the win comes from chunks
 * whose closures barely overlap.
 *
 * Greedy largest-first bin packing: buckets are sorted by size and each is
 * placed in the currently-smallest bin. That balances file counts without
 * splitting a directory needlessly.
 *
 * @param {readonly string[]} items
 * @param {number} count
 * @returns {string[][]}
 */
export function chunk(items, count) {
  if (items.length === 0) return [];

  const n = Math.max(1, count);
  const groups = adaptiveGroups(items, Math.ceil(items.length / n));
  const bins = Array.from({ length: Math.min(n, groups.size) }, () => /** @type {string[]} */ ([]));

  // Largest bucket first, into the emptiest bin. Size then key, so the plan is
  // deterministic — the same commit chunks identically on every runner, which is
  // what makes a chunk failure reproducible.
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  for (const [, files] of ordered) {
    let smallest = bins[0];
    for (const bin of bins) if (bin.length < smallest.length) smallest = bin;
    smallest.push(...files);
  }

  return bins.map((b) => b.sort()).filter((f) => f.length > 0);
}

/**
 * Every file ESLint would lint, repo-relative and sorted.
 *
 * Sourced from `git ls-files` (tracked files only — an untracked scratch file is
 * not something CI should fail on) filtered by ESLint's own `isPathIgnored`.
 * Deriving it from ESLint means the flat config's `ignores` are honoured without
 * this script re-implementing them, which is where a hand-rolled equivalent
 * would drift.
 *
 * Sorted so the chunk plan is deterministic: the same commit produces the same
 * chunks on every runner, which is what makes a failure reproducible.
 *
 * @param {object} [deps]
 * @returns {Promise<string[]>}
 */
export async function lintTargets(deps = {}) {
  const {
    listFiles = () =>
      execFileSync('git', ['-C', ROOT, '-c', 'core.quotePath=false', 'ls-files'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    eslint = new ESLint({ cwd: ROOT }),
    // Injected for the same reason `listFiles` is: the enumeration logic has to
    // be testable without a real tree on disk.
    exists = existsSync,
  } = deps;

  const candidates = listFiles()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && LINTABLE.some((ext) => line.endsWith(ext)));

  const kept = [];
  for (const file of candidates) {
    const absolute = join(ROOT, file);
    // `git ls-files` reads the INDEX, so a file deleted from the working tree
    // but not yet staged is still listed. Handing that path to eslint exits 2
    // ("No files matching the pattern were found") and fails the whole chunk for
    // a reason that has nothing to do with lint — which is exactly the state a
    // developer is in while reproducing a CI failure locally.
    if (!exists(absolute)) continue;
    if (!(await eslint.isPathIgnored(absolute))) kept.push(file);
  }
  return kept.sort();
}

/**
 * How to invoke eslint: `[command, ...leadingArgs]`.
 *
 * Runs eslint's JS entry point under `process.execPath` rather than the `.bin`
 * shim. The shim is a `.cmd` on Windows, and since the CVE-2024-27980 fix
 * (Node >= 18.20.2 / 20.12.2 — this repo requires 24) `spawn` REFUSES a
 * `.bat`/`.cmd` target unless `shell: true`. We cannot pass `shell: true`,
 * because the argv is filenames and a shell would interpret whatever `&` or `^`
 * a path contains. So the Windows branch of a `.bin`-based resolver is
 * unreachable by construction: every chunk would fail with `spawn EINVAL`.
 *
 * Going through `execPath` sidesteps that, and keeps one code path on every
 * platform rather than one that is only ever exercised on two of them.
 *
 * @returns {[string, ...string[]]}
 */
export function resolveEslintCommand() {
  const entry = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (existsSync(entry)) return [process.execPath, entry];
  // Fallback for a global install; still never a shell.
  return [join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? 'eslint.cmd' : 'eslint')];
}

/**
 * The child's environment, with an old-space cap appended when nothing has set
 * one.
 *
 * NOT COSMETIC. Without it `lint:ci` inherits Node's default heap, which is
 * derived from machine RAM and is roughly 2GB on an 8GB box: BELOW the measured
 * 2.64GB floor one chunk needs, so every chunk would abort with exit 134 — the
 * exact failure this script exists to prevent. In CI the workflow's
 * `NODE_OPTIONS` supplies a cap and this stands down; anywhere else (a developer
 * reproducing a CI lint failure, a fork on a different runner) there is nothing
 * else to supply one.
 *
 * Matches `run-capped.mjs`: append to `NODE_OPTIONS` rather than passing
 * `--max-old-space-size` on the command line, and only when no cap is already
 * present, so an explicit value always wins.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withHeapCap(env) {
  if (/(^|\s)--max[-_]old[-_]space[-_]size(\s|=|$)/.test(env.NODE_OPTIONS ?? '')) {
    return { ...env };
  }
  const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${existing}--max-old-space-size=${DEFAULT_HEAP_MB}` };
}

/**
 * Run one chunk. Resolves to its exit code rather than rejecting, so a failing
 * chunk does not abandon the ones after it — a lint run that stops at the first
 * failing chunk reports a fraction of the problems and sends the author round
 * the loop again for each one.
 *
 * @param {readonly string[]} files
 * @param {readonly string[]} passthrough
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export function runChunk(files, passthrough, deps = {}) {
  const { spawnFn = spawn, env = process.env, command = resolveEslintCommand() } = deps;
  const [bin, ...leading] = command;
  return new Promise((resolveCode) => {
    const child = spawnFn(bin, [...leading, ...files, ...passthrough], {
      cwd: ROOT,
      env: withHeapCap(env),
      stdio: 'inherit',
      // `false` even on Windows: the argv is filenames. See the header.
      shell: false,
    });
    child.on('error', (error) => {
      console.error(`Failed to start eslint: ${error.message}`);
      resolveCode(1);
    });
    child.on('exit', (code) => resolveCode(code ?? 1));
  });
}

/**
 * @param {string[]} [argv] Passthrough args for eslint (e.g. `--cache`).
 * @param {object} [deps]
 * @returns {Promise<number>} Worst exit code across the chunks.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    log = console.log,
    warn = console.error,
    targets = await lintTargets(),
    chunks = parseChunks(env.LINT_CHUNKS, warn),
    run = runChunk,
  } = deps;

  if (targets.length === 0) {
    // Loud and FAILING, unlike every other fallback in this file. An empty
    // target list is the silent-pass shape the whole script is written against:
    // `eslint` with no file arguments lints nothing and exits 0, so a broken
    // `git ls-files` or an over-broad `ignores` would report a clean lint of an
    // unlinted tree. There is no tree this repo builds on that legitimately has
    // zero lintable files, so this is a "could not look", not a "found nothing".
    warn('chunked-lint: no lintable files found — refusing to report a clean lint of nothing.');
    return 1;
  }

  const plan = chunk(targets, chunks);
  log(`chunked-lint: ${targets.length} files in ${plan.length} sequential chunk(s).`);

  let worst = 0;
  for (const [i, files] of plan.entries()) {
    log(`chunked-lint: chunk ${i + 1}/${plan.length} — ${files.length} files`);
    const code = await run(files, argv, { env });
    if (code > worst) worst = code;
  }
  return worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

export { ROOT };
