// Runs a toolchain binary under an explicit V8 old-space cap.
//
// WHY THIS EXISTS
// Node derives its default heap from the machine's RAM and then stops there:
// on a 16GB host it is 4288MB, no matter how much of the other 12GB is free.
// Type-aware ESLint over a whole Sunrise repo needs ~4.1GB — base Sunrise
// clears the default by about 2%, and every fork with real code on top does
// not. Measured 18 Aug 2026: HCE Hub and Daybreak both die with **exit 134**
// (SIGABRT, no message naming memory) on a cold `npm run lint`, on machines
// with 16GB free. Bisecting the commit that flipped Hub over found fifty files.
//
// CI has had an explicit cap since #543 (`CI_NODE_HEAP_MB`, default 5120).
// Local runs had none, which is why forks meet this wall on a developer's
// machine first and in its least legible form. This closes that gap: the same
// mechanism, the same units, applied to the same jobs.
//
// IT MUST NOT OVERRIDE AN EXPLICIT CAP — this is the whole reason the script
// is not a one-liner. A command-line `--max-old-space-size` beats one in
// `NODE_OPTIONS`, in both directions:
//
//     NODE_OPTIONS=2048 + CLI 6144  ->  6336   (CLI wins)
//     NODE_OPTIONS=6144 + CLI 2048  ->  2240   (CLI still wins)
//
// So a wrapper that passed the flag on the command line would silently replace
// whatever a fork had measured and set as `CI_NODE_HEAP_MB` with Sunrise's
// hardcoded number — the exact class of failure `.context/architecture/ci.md`
// spends a section warning about. This appends to `NODE_OPTIONS` instead, and
// only when no cap is already there. In CI the workflow's value always wins.
//
// PLAIN .mjs, NO BUILD STEP, NO RUNTIME DEPENDENCY — same rule as
// `dev-server.mjs`. It runs from `npm run lint` in a fresh checkout, before
// anything is compiled.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { totalmem } from 'node:os';
import v8 from 'node:v8';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

/**
 * The bins this wrapper will launch.
 *
 * An allowlist rather than a passthrough, so `package.json` is the only place
 * that decides which jobs get a cap and a typo fails loudly instead of
 * spawning something unexpected.
 *
 * `tsc` is here because the measurement that once kept it out was of a warm
 * run. `tsconfig.json` sets `incremental`, so 1.64-1.75 GiB was `tsc --noEmit`
 * reading its build info. Cold — a fresh clone, or after a large upstream merge
 * — base Sunrise peaks at 2.74 GiB RSS (measured 19 Oct 2026), and ConQuest
 * (~1.9x base) aborted at 4.40 GB under the default and passed at 2.38 GB once
 * capped. `type-check` runs first in `validate`, so an abort there stopped the
 * whole gate before lint or formatting ran (#693).
 *
 * BEFORE ADDING ONE, know what the argv is. Everything this wrapper spawns
 * today takes a **static** argv from `package.json`. On Windows it runs under
 * `shell: true` (needed for the `.cmd` shim), where Node joins the args into a
 * single `cmd.exe` string — and only the command is quoted below, not the
 * args. A caller whose argv contains filenames would therefore hand `cmd.exe`
 * whatever `&` or `^` a path happened to contain. `lint-staged` is exactly
 * that caller — its argv is git-derived filenames — which is why it keeps
 * calling `eslint` directly rather than coming through here. Wiring it (or any
 * other filename-passing caller) through this wrapper means quoting the
 * passthrough args first.
 */
export const BINS = ['eslint', 'tsc'];

/** Cap applied when nothing else asks for one. Matches the worked example in
 * `.context/architecture/ci.md` and the value the largest fork measured. */
export const DEFAULT_HEAP_MB = 6144;

/** Never hand the machine a ceiling it cannot back — above physical memory, a
 * clean V8 abort becomes an OS OOM kill, which is far harder to read. */
export const MEMORY_FRACTION = 0.75;

const MB = 1024 * 1024;

/**
 * Does this `NODE_OPTIONS` value already fix the heap?
 *
 * Matched on the flag name only. `--max-old-space-size` takes its value as
 * `=N` or as the next token, and both forms mean "someone chose a number" —
 * which is all this needs to know to stand down.
 *
 * @param {string | undefined} nodeOptions
 * @returns {boolean}
 */
export function hasHeapCap(nodeOptions) {
  return /(^|\s)--max[-_]old[-_]space[-_]size(\s|=|$)/.test(nodeOptions ?? '');
}

/**
 * The heap Node would have chosen for this machine unaided, in MB — or 0 when
 * this process was itself started under a cap, because then it is unknowable.
 *
 * `heap_size_limit` only means "Node's own default" when nothing set it. Under
 * an inherited `--max-old-space-size=N` in `NODE_OPTIONS` it reads N plus V8's
 * other spaces, so flooring at it handed the child more than was asked for
 * (6144 -> 6336), and on a small box with a large parent cap more than the
 * machine could back (#711). Returning 0 drops the floor rather than guessing.
 *
 * Only `NODE_OPTIONS` counts. A cap passed on this process's own command line
 * (`node --max-old-space-size=12288 scripts/run-capped.mjs ...`) is not
 * inherited by the child, so there V8's limit is the best record of what the
 * caller asked for, and keeping it as the floor stops the child being cut
 * back to the default.
 *
 * @param {object} [opts]
 * @param {string | undefined} [opts.nodeOptions] This process's `NODE_OPTIONS`.
 * @param {number} [opts.heapLimitBytes] V8's reported heap limit.
 * @returns {number}
 */
export function unaidedLimitMb({
  nodeOptions = process.env.NODE_OPTIONS,
  heapLimitBytes = v8.getHeapStatistics().heap_size_limit,
} = {}) {
  if (hasHeapCap(nodeOptions)) return 0;
  return heapLimitBytes / MB;
}

/**
 * The cap to apply, in MB.
 *
 * Floored at whatever Node would have chosen unaided — so a small explicit ask
 * is a no-op rather than a downgrade — and never above a fraction of physical
 * memory, whatever the floor says.
 *
 * @param {object} [opts]
 * @param {number} [opts.requestedMb] Explicit ask (`NODE_HEAP_MB`).
 * @param {number} [opts.totalMemBytes] Physical memory.
 * @param {number} [opts.defaultLimitMb] Node's unaided default for this
 *   machine; 0 for none (see `unaidedLimitMb`).
 * @returns {number}
 */
export function resolveHeapMb({
  requestedMb = DEFAULT_HEAP_MB,
  totalMemBytes = totalmem(),
  defaultLimitMb = unaidedLimitMb(),
} = {}) {
  const affordable = Math.floor((totalMemBytes * MEMORY_FRACTION) / MB);
  return Math.min(affordable, Math.max(Math.round(defaultLimitMb), requestedMb));
}

/**
 * Parse `NODE_HEAP_MB`. A garbage value is ignored rather than fatal: this
 * wrapper sits in front of `npm run lint`, and refusing to lint because an
 * unrelated variable is malformed trades a small problem for a bigger one.
 *
 * @param {string | undefined} raw
 * @returns {number | undefined}
 */
export function parseRequestedMb(raw) {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The child's environment: `NODE_OPTIONS` with a cap appended, or untouched if
 * it already carries one.
 *
 * Typed as a plain string map rather than `NodeJS.ProcessEnv`: this only ever
 * copies strings, and the repo augments `ProcessEnv` with required keys that a
 * caller passing a two-entry literal has no business supplying.
 *
 * @param {Record<string, string | undefined>} env
 * @param {number} heapMb
 * @returns {Record<string, string | undefined>}
 */
export function buildEnv(env, heapMb) {
  if (hasHeapCap(env.NODE_OPTIONS)) return { ...env };
  const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${existing}--max-old-space-size=${heapMb}` };
}

/**
 * Locate a bin the way `dev-server.mjs` does — `node_modules/.bin` when the
 * dependency is installed, the bare name otherwise (so a global install still
 * works). Windows needs a shell for the `.cmd`, and a shell splits on the
 * spaces a checkout path may contain.
 *
 * @param {string} bin
 * @returns {string}
 */
export function resolveBin(bin) {
  const local = join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? `${bin}.cmd` : bin);
  const command = existsSync(local) ? local : bin;
  return IS_WINDOWS ? `"${command}"` : command;
}

/**
 * @param {string[]} argv `[binName, ...passthrough]`
 * @param {object} [deps]
 * @returns {Promise<import('node:child_process').ChildProcess | undefined>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    spawnFn = spawn,
    env = process.env,
    resolveCommand = resolveBin,
    error = console.error,
    exit = process.exit,
    // Signal plumbing is injected for the same reason spawn is: the re-raise
    // path below calls `process.kill` on this process, which under a test
    // runner kills the runner. Injecting makes it assertable, and stops each
    // `main()` in a test suite leaking two real listeners onto the runner.
    onSignal = (signal, handler) => process.on(signal, handler),
    clearSignal = (signal) => process.removeAllListeners(signal),
    raise = (signal) => process.kill(process.pid, signal),
    // Injected so a test can assert what `main` asks for and applies without
    // depending on the RAM of the machine running it (#700).
    resolveHeap = resolveHeapMb,
  } = deps;

  const [name, ...passthrough] = argv;

  if (!BINS.includes(name)) {
    error(`Unknown command "${name ?? ''}". Expected one of: ${BINS.join(', ')}`);
    exit(1);
    return undefined;
  }

  const heapMb = resolveHeap({ requestedMb: parseRequestedMb(env.NODE_HEAP_MB) });

  const child = spawnFn(resolveCommand(name), passthrough, {
    cwd: ROOT,
    env: buildEnv(env, heapMb),
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    onSignal(signal, () => child.kill(signal));
  }

  child.on('error', (spawnError) => {
    error(`Failed to start "${name}": ${spawnError.message}`);
    exit(1);
  });

  child.on('exit', (code, signal) => {
    // Re-raise the child's signal so the shell sees a normal Ctrl-C rather
    // than exit 0. The forwarding handler has to come off first, or it catches
    // this and the wrapper never exits. (Same shape as dev-server.mjs.)
    if (signal) {
      clearSignal(signal);
      raise(signal);
      return;
    }
    exit(code ?? 1);
  });

  return child;
}

// Guarded so tests can import the helpers without spawning anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
