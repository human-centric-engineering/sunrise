/**
 * Database drift check.
 *
 * Probes the deployed DB for every raw-SQL object the Prisma schema cannot
 * model and reports whether each is present. The baseline migration creates
 * each one, but `prisma migrate dev` against a schema-folded DB will silently
 * emit DROP statements for them on every schema-diff run — this script is
 * the canonical post-migration sanity check.
 *
 * Reads `DATABASE_URL` from the environment (loaded from `.env.local` via the
 * project's `lib/db/client` singleton). Exits 0 if every probe succeeds,
 * non-zero on the first failure.
 *
 * Three probe sets run together: Sunrise's own A-series (`DRIFT_OBJECTS`
 * below), the T-series derived from the tenant-owned roster (one
 * `org_isolation` policy probe per table, plus an enabled-and-forced probe at
 * `TENANCY_MODE=multi` — never a hand-written row; see
 * `tenancyDriftProbes`), and any fork-registered probes
 * (`lib/app/db-drift.ts`). Forks register their own unmodelled objects there
 * — they never edit this platform script. The probe primitives and registry
 * live in `@/lib/db/drift-probes`.
 *
 * Runs under `runAsSystem`: the probes are raw catalog reads (`pg_indexes`,
 * `pg_class`, `pg_policies`, `information_schema` — none of them
 * RLS-governed), and at `multi` the chokepoint refuses a raw op with no
 * context. It connects through the app client (`DATABASE_URL`), so the
 * bypass GUC changes nothing about what it can see; it is the scope that
 * lets the probes run at all.
 *
 * Usage:
 *   npm run db:drift-check
 *
 * Optional environment variables:
 *   REFERENCE_DATABASE_URL — if set, prints a hint to run
 *     `atlas schema diff` against the named DB as a second verification.
 *     This script doesn't shell out to atlas itself; it only nudges.
 *
 * FORK NOTE — this script runs your seam rather than asserting on it. Probes
 * registered in `lib/app/db-drift.ts` execute alongside Sunrise's A-series and
 * are reported in the same pass, so a failing probe of yours fails this script.
 * `mergeDriftProbes` throws if one of your names shadows an A-series name, so
 * name yours for your own objects. Nothing in this file needs editing.
 *
 * See `.context/database/prisma-unmodelled-objects.md` for the inventory.
 */

import { registerAppDriftProbes } from '@/lib/app/db-drift';
import { prisma } from '@/lib/db/client';
import {
  constraintExists,
  generatedColumnExists,
  getAppDriftProbes,
  indexExists,
  mergeDriftProbes,
  tenancyDriftProbes,
  type DriftObject,
  type Probe,
} from '@/lib/db/drift-probes';
import { logger } from '@/lib/logging';
import { tenantOwnedModels } from '@/lib/tenancy/classification';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';

/**
 * Probe that the 'english' tsearch configuration exists. A custom or
 * locale-stripped Postgres install can lack it, which silently turns the
 * baseline's `to_tsvector('english', …)` expression into a runtime error
 * on every chunk insert.
 */
const englishTsConfigExists: Probe = async () => {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM pg_ts_config
    WHERE cfgname = 'english'
  `;
  return { ok: Number(rows[0]?.count ?? 0n) === 1 };
};

/**
 * Sunrise's own (platform-owned) unmodelled objects — the A-series. Forks add
 * their own via `lib/app/db-drift.ts`, never by editing this array.
 */
const DRIFT_OBJECTS: DriftObject[] = [
  {
    name: 'A1 searchVector (GENERATED tsvector column)',
    kind: 'column',
    table: 'ai_knowledge_chunk',
    // `generatedColumnExists`, not `columnExists`: the failure this probe
    // exists for is a migration recreating the column as a plain tsvector,
    // which leaves a same-named column that is never populated. Existence
    // alone cannot see that.
    probe: generatedColumnExists('ai_knowledge_chunk', 'searchVector'),
  },
  {
    name: 'A2 idx_ai_knowledge_chunk_search_vector',
    kind: 'GIN index',
    table: 'ai_knowledge_chunk',
    probe: indexExists('idx_ai_knowledge_chunk_search_vector'),
  },
  {
    name: 'A3 idx_knowledge_embedding',
    kind: 'HNSW index',
    table: 'ai_knowledge_chunk',
    probe: indexExists('idx_knowledge_embedding'),
  },
  {
    name: 'A4 idx_message_embedding',
    kind: 'HNSW index',
    table: 'ai_message_embedding',
    probe: indexExists('idx_message_embedding'),
  },
  {
    name: 'A5 idx_knowledge_doc_file_hash_ready (per org)',
    kind: 'partial unique index',
    table: 'ai_knowledge_document',
    probe: indexExists('idx_knowledge_doc_file_hash_ready', '"orgId"'),
  },
  {
    name: 'A6 ai_workflow_execution_lease_pair_coherent (tightened)',
    kind: 'CHECK constraint',
    table: 'ai_workflow_execution',
    probe: constraintExists('ai_workflow_execution_lease_pair_coherent', 'length'),
  },
  {
    name: 'A7 idx_ai_knowledge_base_single_default (per org)',
    kind: 'partial unique index',
    table: 'ai_knowledge_base',
    probe: indexExists('idx_ai_knowledge_base_single_default', '"orgId"'),
  },
  {
    name: 'A8 ai_knowledge_document_status_lowercase',
    kind: 'CHECK constraint',
    table: 'ai_knowledge_document',
    probe: constraintExists('ai_knowledge_document_status_lowercase'),
  },
  {
    name: "Postgres 'english' tsearch configuration",
    kind: 'pg_ts_config row',
    table: '—',
    probe: englishTsConfigExists,
  },
];

async function main(): Promise<void> {
  // Pull in any fork-registered probes (lib/app/db-drift.ts), then run the
  // A-series, the derived T-series and app probes together. mergeDriftProbes
  // throws if a fork reused a platform name.
  registerAppDriftProbes();
  const appProbes = getAppDriftProbes();
  const multi = isMultiTenant();
  const tenancyProbes = tenancyDriftProbes(tenantOwnedModels(prisma), { multi });
  const probes = mergeDriftProbes([...DRIFT_OBJECTS, ...tenancyProbes], appProbes);

  const appSuffix = appProbes.length > 0 ? ` + ${appProbes.length} app` : '';
  logger.info(
    `Running ${probes.length} drift probes against the deployed DB (${DRIFT_OBJECTS.length} platform + ` +
      `${tenancyProbes.length} tenancy at ${multi ? 'multi' : 'single'}${appSuffix})...`
  );

  let failed = 0;

  for (const obj of probes) {
    const result = await obj.probe();
    if (result.ok) {
      logger.info(`  OK    ${obj.name}`);
    } else {
      failed += 1;
      logger.error(`  FAIL  ${obj.name} (${obj.kind} on ${obj.table})`);
      if (result.note) logger.error(`        ${result.note}`);
    }
  }

  if (failed === 0) {
    logger.info(`All ${probes.length} drift probes passed.`);
    if (process.env.REFERENCE_DATABASE_URL) {
      logger.info(
        'Hint: run atlas schema diff against REFERENCE_DATABASE_URL for a full structural check.'
      );
    }
    process.exit(0);
  }

  logger.error(`${failed} of ${probes.length} drift probes failed.`);
  logger.error(
    'Re-run `prisma migrate deploy` against a freshly-baselined scratch DB and atlas-diff against this one to see what shifted.'
  );
  process.exit(1);
}

runAsSystem('db:drift-check', main)
  .catch((err) => {
    logger.error('Drift check crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(2);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
