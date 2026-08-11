/**
 * Scheduled dependency audit — CLI.
 *
 * Asks `npm audit` about the tree **as it stands**, which is the question
 * `dependency-review` structurally cannot answer (it diffs a PR) and the one
 * Dependabot leaves open when a fix lives in a grandparent package. The rules,
 * and the measurements behind gating only on fixable findings, are in
 * `scripts/ci/audit-advisories.ts`.
 *
 * Usage:
 *   npm run check:audit                # fail on fixable high+ findings
 *   npm run check:audit -- --floor=critical
 *   npm run check:audit -- --report    # do not fail on findings (still
 *                                      # fails if the audit cannot be run)
 *
 * Needs the network. Run from CI on a schedule, not from `validate` or the PR
 * pipeline — a PR gate that depends on a third-party advisory feed fails for
 * reasons that have nothing to do with the PR.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import {
  auditError,
  auditIsUsable,
  formatSummary,
  parseAuditReport,
  SEVERITIES,
  summarise,
  triage,
  type Severity,
} from '@/scripts/ci/audit-advisories';

/**
 * Just the environment, narrowed to what this script reads.
 *
 * Not `NodeJS.ProcessEnv`: a CI script has no business depending on the app's
 * env typing, and under this project's config an object literal is not
 * assignable to it — which would force every test to fake the whole app
 * environment to check two keys.
 */
export type Env = Record<string, string | undefined>;

/**
 * npm's own JS entry point, from `npm_execpath`.
 *
 * Taken from the environment rather than by shelling out to `npm`, for the
 * reason `prismaEntry` exists: on Windows the installed `npm` is a `.cmd`,
 * which cannot be spawned without a shell (CVE-2024-27980), and enabling the
 * shell makes argument quoting our problem.
 *
 * There is deliberately no fallback. `npm` is the ambient tool, not a
 * dependency, so it is not resolvable from `node_modules` — an earlier version
 * tried `require.resolve('npm/bin/npm-cli.js')` and threw `Cannot find module`
 * for anyone running the file directly. Guessing a path relative to
 * `process.execPath` would be a platform-specific coin flip. Requiring the npm
 * script is honest, and it is how `package.json` and the workflow both invoke
 * it; the error says so.
 */
export function npmEntry(env: Env = process.env): string {
  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js')) return fromEnv;
  throw new Error(
    "npm_execpath is not set to npm's JS entry point — run this via `npm run check:audit`."
  );
}

/** `--floor=<severity>`, defaulting to `high`. */
export function parseFloor(
  argv: string[]
): { ok: true; floor: Severity } | { ok: false; bad: string } {
  const flag = argv.find((arg) => arg.startsWith('--floor='));
  if (flag === undefined) return { ok: true, floor: 'high' };
  const value = flag.slice('--floor='.length);
  return (SEVERITIES as readonly string[]).includes(value)
    ? { ok: true, floor: value as Severity }
    : { ok: false, bad: value };
}

/**
 * Runs `npm audit --json` and returns its stdout.
 *
 * Takes the environment for the same reason `main` does: without it the real
 * `process.env` leaks into tests, and three of them passed only because npm
 * had set `npm_execpath`. Running the suite through anything else — an IDE
 * runner, `./node_modules/.bin/vitest` — failed on an error about
 * `npm_execpath` rather than the thing under test.
 */
export type AuditRunner = (env?: Env) => string;

/**
 * `npm audit` exits **1** when it finds anything, so a non-zero exit is not an
 * error here — the JSON still comes back on stdout and is the thing we want.
 * Only an empty stdout means the command genuinely failed.
 */
export const runNpmAudit: AuditRunner = (env: Env = process.env) => {
  try {
    return execFileSync(process.execPath, [npmEntry(env), 'audit', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error ? error.stdout : undefined;
    if (typeof stdout === 'string' && stdout.trim() !== '') return stdout;
    throw error instanceof Error ? error : new Error(String(error));
  }
};

/** Appends the markdown summary to the GitHub step summary, when running there. */
function writeStepSummary(markdown: string, env: Env): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (typeof path !== 'string' || path === '') return;
  try {
    appendFileSync(path, markdown + '\n');
  } catch (error) {
    // Never fail the security check because the cosmetic summary would not
    // write — the console output above already carries every finding.
    console.error(
      `Note: could not write the step summary: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(
  argv: string[],
  run: AuditRunner = runNpmAudit,
  env: Env = process.env
): number {
  const requested = parseFloor(argv);
  if (!requested.ok) {
    console.error(
      `Unknown severity "${requested.bad}". Expected one of: ${SEVERITIES.join(', ')}.`
    );
    return 1;
  }
  const { floor } = requested;
  const reportOnly = argv.includes('--report');

  let stdout: string;
  try {
    stdout = run(env);
  } catch (error) {
    console.error('Could not run `npm audit`.');
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    console.error('`npm audit --json` did not return JSON.');
    console.error(stdout.slice(0, 400));
    return 1;
  }

  // Fail loudly on a report we could not read. An unrecognised shape parses to
  // zero advisories, which is indistinguishable from a clean tree — and
  // "green because we went blind" is the worst outcome for a security check.
  if (!auditIsUsable(raw)) {
    // npm reports a registry failure as well-formed JSON: `{"error":{...}}`.
    // That parses, then fails the shape check, so lumping the two together
    // told an operator whose network was down that npm had changed its output
    // format — and printed none of the payload to contradict it.
    const failure = auditError(raw);
    if (failure !== null) {
      console.error('`npm audit` could not complete:');
      console.error(`  ${failure}`);
      console.error('Nothing was checked, so this is not a clean tree.');
      return 1;
    }
    console.error('`npm audit --json` returned an unrecognised report shape.');
    console.error('Refusing to report a clean tree from output this could not read.');
    console.error(stdout.slice(0, 400));
    return 1;
  }

  const result = triage(parseAuditReport(raw), floor);
  console.log(`npm audit: ${summarise(result, floor)}`);

  for (const advisory of result.blocking) {
    console.error(
      `  ✖ ${advisory.name} (${advisory.severity}) — fix available${advisory.fixTarget ? `: ${advisory.fixTarget}` : ''}`
    );
  }
  for (const advisory of result.needsMajor) {
    console.log(`  ~ ${advisory.name} (${advisory.severity}) — fix needs a major bump`);
  }
  for (const advisory of result.unfixable) {
    console.log(`  · ${advisory.name} (${advisory.severity}) — no fix published`);
  }

  writeStepSummary(formatSummary(result, floor), env);

  if (result.blocking.length === 0) {
    console.log(`No fixable ${floor}+ advisories.`);
    // Not "no vulnerabilities": the other buckets may well be occupied, and
    // saying otherwise is the overclaim this whole job exists to avoid.
    if (result.unfixable.length + result.needsMajor.length > 0) {
      console.log(
        `${result.unfixable.length + result.needsMajor.length} ${floor}+ advisory(ies) remain, reported above — nothing installable clears them today.`
      );
    }
    return 0;
  }

  if (reportOnly) {
    console.log(`--report: ${result.blocking.length} fixable finding(s), not failing.`);
    return 0;
  }

  console.error('');
  console.error(
    `${result.blocking.length} fixable ${floor}+ advisory(ies). A patched version is reachable —`
  );
  console.error('check the open Dependabot PRs first, then `npm audit fix` for the remainder.');
  return 1;
}

// Guarded: importing this module must not shell out to npm. See
// `fix-lockfile-libc.ts` for why the unguarded `check-lockfile.ts` convention
// does not transfer to a script with side effects.
export function isDirectRun(scriptPath: string | undefined): boolean {
  return scriptPath !== undefined && /(?:^|[\\/])check-audit\.(?:ts|js|mjs|cjs)$/.test(scriptPath);
}

if (isDirectRun(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
