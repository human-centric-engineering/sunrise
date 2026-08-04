// Dev/preview server launcher that resolves the listen port from the
// project's env files.
//
// WHY THIS EXISTS
// Next's CLI binds `--port` to the `PORT` environment variable at argument-
// parse time (`next/dist/bin/next`), which happens *before* Next loads any
// `.env` file. A `PORT=` line in `.env.local` is therefore read by the app but
// ignored by the server that hosts it. react-email's `email dev` is worse: its
// port is a plain commander default with no env binding at all.
//
// That makes running several Sunrise apps side by side a memory exercise —
// every `npm run dev` needs the right `-p` typed by hand. This script closes
// the gap: it reads *only* the port variable out of the env files, using the
// same precedence Next uses, and hands it to the child process. Each app then
// declares its own port once (commit it to `.env.development` — the one env
// file `.gitignore` permits) and `npm run dev` just works, in every fork.
//
// The port a fork binds locally is independent of the URL it is served on.
// Behind a reverse proxy, set PORT to the loopback port and point
// NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL at the proxied hostname.
//
// PLAIN .mjs, NO BUILD STEP, NO RUNTIME DEPENDENCY — deliberately. `npm start`
// must survive a production install (`npm ci --omit=dev`), which prunes both
// tsx and dotenv. dotenv is loaded optionally below; without it the launcher
// still starts the server, it just cannot read the env files. Deployed
// containers do not need it to: the Docker image runs the standalone server
// (`node server.js`), which reads `process.env.PORT` itself.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

/**
 * @typedef {object} Target
 * @property {string} bin        executable in node_modules/.bin
 * @property {string[]} args     leading arguments
 * @property {string} envVar     env var carrying the port
 * @property {'env' | 'flag'} inject  how the child receives the port
 * @property {string} nodeEnv    which `.env.<nodeEnv>` files apply
 */

/**
 * `env` targets have their port injected as an environment variable (Next's
 * CLI reads PORT itself); `flag` targets get an explicit `-p` because their
 * CLI has no env binding.
 *
 * @type {Record<string, Target>}
 */
export const TARGETS = {
  'next-dev': { bin: 'next', args: ['dev'], envVar: 'PORT', inject: 'env', nodeEnv: 'development' },
  'next-start': {
    bin: 'next',
    args: ['start'],
    envVar: 'PORT',
    inject: 'env',
    nodeEnv: 'production',
  },
  'email-dev': {
    bin: 'email',
    args: ['dev'],
    envVar: 'EMAIL_PORT',
    inject: 'flag',
    nodeEnv: 'development',
  },
};

/**
 * Env files in Next's own precedence order (highest first), per
 * https://nextjs.org/docs/app/guides/environment-variables.
 *
 * @param {string} nodeEnv
 * @returns {string[]}
 */
export function envFilesFor(nodeEnv) {
  return [`.env.${nodeEnv}.local`, '.env.local', `.env.${nodeEnv}`, '.env'];
}

/**
 * True when the operator passed a port explicitly. An explicit flag always
 * wins — `npm run dev -- -p 4100` must override the env files, exactly as it
 * would if this launcher were not in the way.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
export function hasExplicitPortFlag(args) {
  return args.some((arg) => arg === '-p' || arg === '--port' || arg.startsWith('--port='));
}

/**
 * A typo in an env file otherwise surfaces as an opaque failure from whichever
 * CLI received it — worse, `email dev` would fall back to its own default and
 * quietly bind a port the operator did not choose. Fail here instead, where the
 * file that set it is still known.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidPort(value) {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
}

/**
 * Read one variable out of the candidate files, returning the first hit and
 * the file it came from. The source matters: with several apps running, "which
 * file set this port" is the question an operator actually has.
 *
 * IO is injected so the precedence rules can be tested without a filesystem.
 *
 * @param {string} varName
 * @param {string[]} files                              highest precedence first
 * @param {(file: string) => string | null} readFile    contents, or null if absent
 * @param {(raw: string) => Record<string, string | undefined>} parseEnv
 * @returns {{ value: string, file: string } | null}
 */
export function readPortFromFiles(varName, files, readFile, parseEnv) {
  for (const file of files) {
    const raw = readFile(file);
    if (raw === null) continue;
    const value = parseEnv(raw)[varName];
    if (value) return { value, file };
  }
  return null;
}

/**
 * Build the child's argv and port-carrying env additions.
 *
 * @param {Target} target
 * @param {string[]} passthrough
 * @param {string | null} port
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function buildLaunch(target, passthrough, port) {
  const args = [...target.args, ...passthrough];
  /** @type {Record<string, string>} */
  const env = {};

  if (port !== null) {
    if (target.inject === 'env') {
      env[target.envVar] = port;
    } else {
      args.push('-p', port);
    }
  }

  return { args, env };
}

/**
 * Resolve the executable. npm puts `node_modules/.bin` on PATH for scripts, but
 * this file is also runnable directly (`node scripts/dev-server.mjs next-dev`),
 * where it is not.
 *
 * @param {string} bin
 * @returns {string}
 */
function resolveBin(bin) {
  const local = join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? `${bin}.cmd` : bin);
  const command = existsSync(local) ? local : bin;
  // Windows needs a shell to run a `.cmd`, and a shell splits on the spaces a
  // checkout path may contain ("C:\Users\Some Name\...").
  return IS_WINDOWS ? `"${command}"` : command;
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readProjectFile(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Where the port comes from, and in what order.
 *
 * IO is injected (defaulting to the real filesystem, environment and dotenv) so
 * the precedence rules can be exercised without a filesystem or a dotenv
 * install — including the pruned-dotenv path, which by definition cannot be
 * reproduced in a dev checkout.
 *
 * @param {Target} target
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   readFile?: (file: string) => string | null,
 *   loadParser?: () => Promise<(raw: string) => Record<string, string | undefined>>,
 *   warn?: (message: string) => void,
 * }} [io]
 * @returns {Promise<{ value: string, file: string } | null>}
 */
export async function resolvePort(target, io = {}) {
  const {
    env = process.env,
    readFile = readProjectFile,
    loadParser = async () => (await import('dotenv')).parse,
    warn = console.warn,
  } = io;

  // A real environment variable (`PORT=4100 npm run dev`, Docker, a PaaS)
  // outranks the env files — it is the more specific, more deliberate signal.
  const fromShell = env[target.envVar];
  if (fromShell) return { value: fromShell, file: 'environment' };

  const files = envFilesFor(target.nodeEnv);

  let parseEnv;
  try {
    parseEnv = await loadParser();
  } catch {
    // Pruned by a production install. Say so rather than silently ignoring a
    // port the operator believes they configured.
    warn(
      `> dotenv is not installed — cannot read ${target.envVar} from env files; using the default port`
    );
    return null;
  }

  return readPortFromFiles(target.envVar, files, readFile, parseEnv);
}

/**
 * Resolve the port, validate it, and hand the child process its arguments.
 *
 * @param {string[]} argv - arguments after the script name
 * @param {{
 *   spawnFn?: typeof spawn,
 *   io?: Parameters<typeof resolvePort>[1],
 *   log?: (message: string) => void,
 *   error?: (message: string) => void,
 *   exit?: (code: number) => void,
 * }} [deps]
 * @returns {Promise<import('node:child_process').ChildProcess | undefined>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    spawnFn = spawn,
    io,
    log = console.log,
    error = console.error,
    exit = process.exit,
  } = deps;

  const [name, ...passthrough] = argv;
  const target = TARGETS[name];

  if (!target) {
    error(`Unknown target "${name ?? ''}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);
    exit(1);
    return undefined;
  }

  const found = hasExplicitPortFlag(passthrough) ? null : await resolvePort(target, io);

  if (found && !isValidPort(found.value)) {
    error(
      `${target.envVar}="${found.value}" (from ${found.file}) is not a valid port. Expected 1-65535.`
    );
    exit(1);
    return undefined;
  }

  const { args, env } = buildLaunch(target, passthrough, found?.value ?? null);

  if (found) log(`> ${target.envVar}=${found.value} (from ${found.file})`);

  const child = spawnFn(resolveBin(target.bin), args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('error', (spawnError) => {
    error(`Failed to start "${target.bin}": ${spawnError.message}`);
    exit(1);
  });

  child.on('exit', (code, signal) => {
    // Re-raise the child's signal so the shell sees a normal Ctrl-C, not exit
    // 0. The forwarding handler above has to come off first or it catches this
    // and the launcher never exits.
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    exit(code ?? 1);
  });

  return child;
}

// Guarded so tests can import the resolution helpers without spawning anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
