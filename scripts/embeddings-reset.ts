/**
 * Reset embedding storage to match the currently-active embedding model.
 *
 * Use when you've changed `AiOrchestrationSettings.activeEmbeddingModelId`
 * to a model with a different output dimension, or when you want to
 * forcibly re-embed the corpus from scratch with the configured model.
 *
 * SCOPE — touches three tables only:
 *   - `ai_knowledge_chunk`           (vector column resized + table truncated)
 *   - `ai_knowledge_document`        (truncated; cascades to tags + agent grants)
 *   - `ai_message_embedding`         (vector column resized + table truncated)
 *
 * Never touches `user`, `session`, `account`, `ai_orchestration_settings`,
 * provider configs, models, agents, capabilities, workflows, conversations,
 * messages, audit log, or anything else. Specifically does NOT run
 * `db:reset` / `prisma migrate reset`.
 *
 * Run via: `npm run embeddings:reset` (add `--yes` to skip confirmation).
 */
import dotenv from 'dotenv';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getActiveEmbeddingModelSummary } from '@/lib/orchestration/knowledge/embedder';

const FALLBACK_DIMENSIONS = 1536;

interface ResolvedTarget {
  dimensions: number;
  modelLabel: string;
}

async function resolveTargetDimensions(): Promise<ResolvedTarget> {
  const active = await getActiveEmbeddingModelSummary();
  if (active) {
    return {
      dimensions: active.dimensions,
      modelLabel: `${active.modelId} (active in AiOrchestrationSettings)`,
    };
  }
  return {
    dimensions: FALLBACK_DIMENSIONS,
    modelLabel: `text-embedding-3-small (legacy fallback; no activeEmbeddingModelId set)`,
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');
  const target = await resolveTargetDimensions();

  // Surface what will happen before asking. Includes counts so the
  // operator sees what's about to disappear.
  const [chunkCount, docCount, msgEmbedCount] = await Promise.all([
    prisma.aiKnowledgeChunk.count(),
    prisma.aiKnowledgeDocument.count(),
    prisma.aiMessageEmbedding.count(),
  ]);

  logger.info('🔄 Embeddings reset — plan');
  logger.info(`   target dimension: ${target.dimensions}`);
  logger.info(`   target model:     ${target.modelLabel}`);
  logger.info('   destructive ops:');
  logger.info(`     • TRUNCATE ai_knowledge_chunk            (${chunkCount} rows)`);
  logger.info(`     • TRUNCATE ai_knowledge_document         (${docCount} rows)`);
  logger.info(`     • TRUNCATE ai_message_embedding          (${msgEmbedCount} rows)`);
  logger.info(`     • DROP+RECREATE vector(${target.dimensions}) on both tables`);
  logger.info(`     • REBUILD HNSW indexes on both tables`);
  logger.info('   untouched: users, settings, providers, models, agents, workflows, …');

  if (!skipConfirm) {
    const ok = await confirm(`\n   Continue? Type "yes" to proceed (anything else aborts): `);
    if (!ok) {
      logger.info('🟡 Aborted by user — no changes made.');
      process.exit(0);
    }
  }

  const dim = target.dimensions;

  // 1) Drop dependent HNSW indexes — they reference the embedding columns
  // we're about to drop, so they have to go first.
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "idx_knowledge_embedding"`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "idx_message_embedding"`);

  // 2) Truncate the data. Documents cascade to chunks via ON DELETE
  // CASCADE; we also list chunks explicitly to be defensive. Message
  // embeddings are independent.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ai_knowledge_chunk", "ai_knowledge_document", "ai_message_embedding" CASCADE`
  );

  // 3) Rebuild the embedding columns at the target dimension. Chunks
  // use a nullable column (seeder writes content first, embeds later);
  // message embeddings require NOT NULL because they're always inserted
  // alongside a generated vector.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ai_knowledge_chunk" DROP COLUMN IF EXISTS "embedding"`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ai_knowledge_chunk" ADD COLUMN "embedding" vector(${dim})`
  );

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ai_message_embedding" DROP COLUMN IF EXISTS "embedding"`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ai_message_embedding" ADD COLUMN "embedding" vector(${dim}) NOT NULL`
  );

  // 4) Rebuild the HNSW indexes. m=16 / ef_construction=64 mirrors the
  // values in the original migrations so re-created indexes have the
  // same performance characteristics.
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "idx_knowledge_embedding" ON "ai_knowledge_chunk" ` +
      `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "idx_message_embedding" ON "ai_message_embedding" ` +
      `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`
  );

  logger.info('✅ Embeddings reset complete', { dimensions: dim });
  logger.info('   Next steps:');
  logger.info('     1. Re-upload documents via the admin UI (knowledge tab), or');
  logger.info('     2. Run `npm run db:seed:embeddings` if you have a seeder set up.');
}

main()
  .catch((err) => {
    logger.error('❌ Embeddings reset failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
