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
 * `tsc` is deliberately absent. Measured peak for `tsc --noEmit` is 1.64-1.75
 * GiB across Sunrise, Hub and Daybreak — a factor of 2.4 under the default, so
 * capping it would be speculation, not a fix. Adding it later is one entry
 * here plus the script in `package.json`.
 */
export const BINS = ['eslint'];

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
 * The cap to apply, in MB.
 *
 * Clamped down to a fraction of physical memory, then floored at whatever Node
 * would have chosen unaided — so on a machine too small for the requested cap
 * the wrapper is a no-op rather than a downgrade.
 *
 * @param {object} [opts]
 * @param {number} [opts.requestedMb] Explicit ask (`NODE_HEAP_MB`).
 * @param {number} [opts.totalMemBytes] Physical memory.
 * @param {number} [opts.defaultLimitMb] Node's own default for this machine.
 * @returns {number}
 */
export function resolveHeapMb({
  requestedMb = DEFAULT_HEAP_MB,
  totalMemBytes = totalmem(),
  defaultLimitMb = v8.getHeapStatistics().heap_size_limit / MB,
} = {}) {
  const affordable = Math.floor((totalMemBytes * MEMORY_FRACTION) / MB);
  return Math.max(Math.round(defaultLimitMb), Math.min(requestedMb, affordable));
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
function resolveBin(bin) {
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
  } = deps;

  const [name, ...passthrough] = argv;

  if (!BINS.includes(name)) {
    error(`Unknown command "${name ?? ''}". Expected one of: ${BINS.join(', ')}`);
    exit(1);
    return undefined;
  }

  const heapMb = resolveHeapMb({ requestedMb: parseRequestedMb(env.NODE_HEAP_MB) });

  const child = spawnFn(resolveCommand(name), passthrough, {
    cwd: ROOT,
    env: buildEnv(env, heapMb),
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
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
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
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
