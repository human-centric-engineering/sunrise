/**
 * Turn row isolation on or off (§107 t-707).
 *
 *   npm run db:tenancy:enable     ENABLE + FORCE ROW LEVEL SECURITY on every
 *                                 tenant-owned table, after backfilling any
 *                                 NULL orgId to the install org
 *   npm run db:tenancy:disable    DISABLE + NO FORCE (both — the two pg_class
 *                                 flags are independent; DISABLE alone leaves
 *                                 FORCE set)
 *
 * The policies themselves ship dormant with the schema
 * (`prisma/migrations/20260920120000_org_isolation_policies`); this only
 * flips the flags that make Postgres consult them. Idempotent: the plan is
 * computed from the flags as read, a table already in the requested state
 * gets no statement, and a second run reports "no change". Mode-agnostic —
 * it does not read `TENANCY_MODE`; enabling at `single` is safe (the
 * chokepoint issues no setter there, so the app sees no rows — which is the
 * point of running it only when you mean it).
 *
 * Connects with `MIGRATE_DATABASE_URL` when set, else `DATABASE_URL` — the
 * owner role, never the restricted app role: `ALTER TABLE` needs the owner,
 * and the tenant-owned tables are derived from the generated client's runtime
 * data model, so a fork's model is covered the moment it carries `orgId`.
 * The whole run is one transaction: either every table flips or none does.
 *
 * Exit codes: 0 done (or nothing to do), 1 a table did not reach the
 * requested state, 2 could not run (no DSN, connection refused, a table the
 * migrations have not created).
 *
 * @see .context/tenancy/isolation.md
 */

import { Client } from 'pg';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { tenantOwnedModels } from '@/lib/tenancy/classification';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runTenancySwitch, type TenancySwitch } from '@/lib/tenancy/isolation';

function parseMode(argv: readonly string[]): TenancySwitch {
  if (argv.includes('--disable')) return 'disable';
  if (argv.includes('--enable') || argv.length === 0) return 'enable';
  throw new Error(`Unknown argument(s): ${argv.join(' ')} — use --enable (default) or --disable`);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const dsn = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dsn) throw new Error('set MIGRATE_DATABASE_URL (or DATABASE_URL) to the owner role’s DSN');

  const tables = [...tenantOwnedModels(prisma).values()];
  logger.info(`db:tenancy:${mode} — ${tables.length} tenant-owned tables`);

  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query('BEGIN');
    const report = await runTenancySwitch(client, tables, mode, INSTALL_ORG_ID);
    await client.query('COMMIT');

    // One line per table that changed (or was backfilled); the unchanged
    // ones are the summary's business, so a no-op run is two lines.
    for (const entry of report.entries) {
      if (entry.statements.length === 0 && entry.backfilled === 0) continue;
      const change =
        entry.statements.length === 0
          ? 'unchanged'
          : entry.statements.map((s) => s.replace(/^ALTER TABLE "[^"]+" /, '')).join(' + ');
      const backfill = entry.backfilled > 0 ? ` (backfilled ${entry.backfilled} NULL orgId)` : '';
      logger.info(`  ${entry.table}: ${change}${backfill}`);
    }
    if (report.noop) {
      logger.info(
        `db:tenancy:${mode}: no change — all ${tables.length} tables were already ${mode}d`
      );
    } else {
      const changed = report.entries.filter((e) => e.statements.length > 0).length;
      logger.info(`db:tenancy:${mode}: ${changed} of ${tables.length} tables changed`);
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`db:tenancy failed: ${message}`);
  // "did not reach the requested state" is the one failure that is about the
  // database's answer rather than about being able to ask.
  process.exit(/did not reach the requested state/.test(message) ? 1 : 2);
});
