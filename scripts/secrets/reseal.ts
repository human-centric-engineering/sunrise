/**
 * `npm run secrets:reseal [-- --dry-run]` — move every sealed secret onto the
 * active master key, so an old key can be removed (§137 t-1043).
 *
 * Run it after pointing `SEALED_SECRET_ACTIVE_KEY` at a new key, and before
 * removing the old one from `SEALED_SECRET_KEYS`. `--dry-run` counts what
 * would move and writes nothing. Safe to run again: values already on the
 * active key are left alone.
 *
 * Exit codes: 0 every value is on the active key (or would be, on a dry run);
 * 1 some value could not be moved, a store could not be read, or a value
 * changed during the run, so do NOT remove the old key yet (run it again);
 * 2 the run could not start (no keyring, a keyring lib/env.ts refused, an
 * argument it does not know, or the app's store registration failed).
 *
 * **The report is printed, not logged**, so `LOG_LEVEL` cannot hide it: it is
 * what the operator decides on. Every report line starts `secrets:reseal `:
 * one per store (`secrets:reseal store {json}`), then a summary. Log lines
 * from the run (each store's walk enters `runAsSystem`, which logs) share
 * stdout, so read the report by that prefix.
 *
 * It exits only once stdout and stderr have flushed: a write to a pipe is
 * asynchronous on macOS, and `process.exit()` straight after one can cut the
 * report off (`… | tee reseal.log`).
 *
 * Outside development, run it where the app's environment is set:
 * `npx tsx scripts/secrets/reseal.ts`.
 *
 * @see lib/security/sealed-stores.ts
 * @see .context/security/sealed-secrets.md
 */

import type { SealedStoresResealReport } from '@/lib/security/sealed-stores';

/** Write a line of the report. The command's output, not a log line. */
function print(line: string): void {
  process.stdout.write(`secrets:reseal ${line}\n`);
}

/** Write why the run could not start. */
function printError(line: string): void {
  process.stderr.write(`secrets:reseal could not start: ${line}\n`);
}

/** Exit with `code` once everything written so far has flushed. */
function finish(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

/**
 * Whether this is a dry run, or `null` for arguments it does not know.
 *
 * Strict on purpose: a mistyped `--dry-run` would otherwise be a real,
 * writing run. And `npm run secrets:reseal --dry-run`, without the `--`, gives
 * the flag to npm rather than to this script; npm then sets
 * `npm_config_dry_run`, which is read here as the dry run it was meant to be.
 */
function readDryRun(args: readonly string[]): boolean | null {
  if (args.some((arg) => arg !== '--dry-run')) return null;
  return args.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = readDryRun(args);
  if (dryRun === null) {
    printError(`unknown argument(s) ${JSON.stringify(args)}; the only one is --dry-run.`);
    return finish(2);
  }

  // Loaded here rather than imported at the top, so that a module that fails
  // to load exits 2 like every other failure to start. For an environment
  // lib/env.ts refused, it has already printed the variables at fault, never
  // a secret; the name and message here say which module it was.
  let resealSealedStores;
  try {
    ({ resealSealedStores } = await import('@/lib/security/sealed-stores'));
  } catch (err) {
    printError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return finish(2);
  }

  let report: SealedStoresResealReport;
  try {
    report = await resealSealedStores({ dryRun });
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return finish(2);
  }

  for (const store of report.stores) {
    print(
      'store ' +
        JSON.stringify({
          store: store.store,
          scanned: store.scanned,
          alreadyCurrent: store.alreadyCurrent,
          [dryRun ? 'wouldReseal' : 'resealed']: store.resealed,
          changedMeanwhile: store.changedMeanwhile,
          failed: store.failed,
          ...(store.error ? { error: store.error } : {}),
        })
    );
  }

  const key = `"${report.activeKeyId}"`;
  const changed = report.stores.reduce((n, s) => n + s.changedMeanwhile, 0);
  const stuck = report.stores.some((s) => s.error !== undefined || s.failed.length > 0);
  let summary: string;
  if (stuck) {
    summary = `some values are NOT on key ${key}. Do not remove an old key until a run is clean.`;
  } else if (!report.ok) {
    summary = `${changed} value(s) changed during the run, so it cannot say they are on key ${key}. Run it again before removing an old key.`;
  } else if (report.stores.length === 0) {
    summary = 'no sealed stores are registered, so there was nothing to move.';
  } else {
    summary = dryRun
      ? `dry run: every value can move onto key ${key}.`
      : `done: every value is on key ${key}.`;
  }
  print(summary);
  return finish(report.ok ? 0 : 1);
}

void main();
