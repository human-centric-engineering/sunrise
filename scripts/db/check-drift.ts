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
 * Usage:
 *   npm run db:drift-check
 *
 * Optional environment variables:
 *   REFERENCE_DATABASE_URL — if set, prints a hint to run
 *     `atlas schema diff` against the named DB as a second verification.
 *     This script doesn't shell out to atlas itself; it only nudges.
 *
 * See `.context/database/prisma-unmodelled-objects.md` for the inventory.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

interface ProbeResult {
  ok: boolean;
  note?: string;
}

type Probe = () => Promise<ProbeResult>;

interface DriftObject {
  name: string;
  kind: string;
  table: string;
  probe: Probe;
}

/**
 * Existence probe by index name in pg_indexes.
 */
function indexExists(indexName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_indexes
      WHERE indexname = ${indexName}
    `;
    return { ok: Number(rows[0]?.count ?? 0n) === 1 };
  };
}

/**
 * Existence probe by constraint name in pg_constraint.
 * Optional `predicateContains` substring asserts the CHECK predicate text
 * — used by A6 to confirm the tightened version landed.
 */
function constraintExists(constraintName: string, predicateContains?: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string | null }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = ${constraintName}
    `;
    const def = rows[0]?.def;
    if (!def) return { ok: false };
    if (predicateContains && !def.includes(predicateContains)) {
      return {
        ok: false,
        note: `predicate missing "${predicateContains}" — saw: ${def}`,
      };
    }
    return { ok: true };
  };
}

/**
 * Existence probe by column name in information_schema.columns. Used for
 * A1 (the GENERATED tsvector column on ai_knowledge_chunk).
 */
function columnExists(tableName: string, columnName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    `;
    return { ok: Number(rows[0]?.count ?? 0n) === 1 };
  };
}

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

const DRIFT_OBJECTS: DriftObject[] = [
  {
    name: 'A1 searchVector (GENERATED tsvector column)',
    kind: 'column',
    table: 'ai_knowledge_chunk',
    probe: columnExists('ai_knowledge_chunk', 'searchVector'),
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
    name: 'A5 idx_knowledge_doc_file_hash_ready',
    kind: 'partial unique index',
    table: 'ai_knowledge_document',
    probe: indexExists('idx_knowledge_doc_file_hash_ready'),
  },
  {
    name: 'A6 ai_workflow_execution_lease_pair_coherent (tightened)',
    kind: 'CHECK constraint',
    table: 'ai_workflow_execution',
    probe: constraintExists('ai_workflow_execution_lease_pair_coherent', 'length'),
  },
  {
    name: 'A7 idx_ai_knowledge_base_single_default',
    kind: 'partial unique index',
    table: 'ai_knowledge_base',
    probe: indexExists('idx_ai_knowledge_base_single_default'),
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
  logger.info(`Running ${DRIFT_OBJECTS.length} drift probes against the deployed DB...`);

  let failed = 0;

  for (const obj of DRIFT_OBJECTS) {
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
    logger.info(`All ${DRIFT_OBJECTS.length} drift probes passed.`);
    if (process.env.REFERENCE_DATABASE_URL) {
      logger.info(
        'Hint: run atlas schema diff against REFERENCE_DATABASE_URL for a full structural check.'
      );
    }
    process.exit(0);
  }

  logger.error(`${failed} of ${DRIFT_OBJECTS.length} drift probes failed.`);
  logger.error(
    'Re-run `prisma migrate deploy` against a freshly-baselined scratch DB and atlas-diff against this one to see what shifted.'
  );
  process.exit(1);
}

main()
  .catch((err) => {
    logger.error('Drift check crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(2);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
