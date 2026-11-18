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
 * 1 some value could not be moved, or a store could not be read, so do NOT
 * remove the old key yet; 2 the run could not start (no keyring, or the app's
 * store registration failed).
 *
 * Outside development, run it where the app's environment is set:
 * `npx tsx scripts/secrets/reseal.ts`.
 *
 * @see lib/security/sealed-stores.ts
 * @see .context/security/sealed-secrets.md
 */

import type { SealedStoresResealReport } from '@/lib/security/sealed-stores';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  // Loaded here rather than imported at the top, so that an environment
  // lib/env.ts refuses (a malformed keyring) exits 2 like every other failure
  // to start. lib/env.ts has already printed what is wrong by then, naming the
  // variables and never a secret.
  let modules;
  try {
    modules = {
      ...(await import('@/lib/logging')),
      ...(await import('@/lib/security/sealed-stores')),
    };
  } catch {
    process.exit(2);
  }
  const { logger, resealSealedStores } = modules;

  let report: SealedStoresResealReport;
  try {
    report = await resealSealedStores({ dryRun });
  } catch (err) {
    logger.error(
      `secrets:reseal could not start: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
  }

  for (const store of report.stores) {
    logger.info(`secrets:reseal ${store.store}`, {
      scanned: store.scanned,
      alreadyCurrent: store.alreadyCurrent,
      [dryRun ? 'wouldReseal' : 'resealed']: store.resealed,
      changedMeanwhile: store.changedMeanwhile,
      failed: store.failed,
      ...(store.error ? { error: store.error } : {}),
    });
  }
  const key = `"${report.activeKeyId}"`;
  let summary: string;
  if (!report.ok) {
    summary = `some values are NOT on key ${key}. Do not remove an old key until a run is clean.`;
  } else if (report.stores.length === 0) {
    summary = `no sealed stores are registered, so there was nothing to move.`;
  } else {
    summary = dryRun
      ? `dry run: every value can move onto key ${key}.`
      : `done: every value is on key ${key}.`;
  }
  logger.info(`secrets:reseal ${summary}`, { stores: report.stores.length, dryRun });
  process.exit(report.ok ? 0 : 1);
}

void main();
