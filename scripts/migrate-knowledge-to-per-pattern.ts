import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import path from 'path';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';

/**
 * Migrate the seeded "Agentic Design Patterns" knowledge from the legacy
 * single-document layout (one document with 191 chunks) to the per-pattern
 * layout (21 pattern documents + 1 reference document). The new layout makes
 * the 10 category tags actually useful for agent scoping — granting an agent
 * the "Architecture" tag in restricted mode will now give it access only to
 * the documents tagged Architecture, instead of the one giant doc that
 * contains everything.
 *
 * Cost: the legacy doc's chunks (and their embeddings) are deleted. The new
 * layout re-seeds from chunks.json, but embeddings have to be regenerated
 * via `npm run db:seed:embeddings`. On a small KB this is a few minutes and
 * a few cents of provider spend, depending on which embedding provider you
 * have configured.
 *
 * Safe to re-run: if the legacy doc is already gone and the per-pattern
 * layout already exists, the seeder skips and the script exits cleanly.
 */

const LEGACY_NAME = 'Agentic Design Patterns';

async function main(): Promise<void> {
  logger.info('🔁 Migrating knowledge to per-pattern layout');

  const legacy = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: LEGACY_NAME, scope: 'system' },
    select: { id: true, status: true, chunkCount: true },
  });

  if (legacy) {
    logger.info('Removing legacy single-document seed', {
      documentId: legacy.id,
      chunkCount: legacy.chunkCount,
    });
    // chunks cascade via the document FK; embeddings live on chunks so they
    // disappear with them.
    await prisma.aiKnowledgeDocument.delete({ where: { id: legacy.id } });
    logger.info('Legacy document removed');
  } else {
    logger.info('No legacy document found — proceeding to seed');
  }

  const chunksPath = path.resolve(
    process.cwd(),
    'prisma',
    'seeds',
    'data',
    'chunks',
    'chunks.json'
  );

  await seedChunks(chunksPath);

  // Report the new layout for the operator.
  const newDocs = await prisma.aiKnowledgeDocument.findMany({
    where: { scope: 'system', fileName: { startsWith: 'agentic-design-patterns-' } },
    select: {
      name: true,
      chunkCount: true,
      tags: { include: { tag: { select: { slug: true } } } },
    },
    orderBy: { fileName: 'asc' },
  });

  logger.info('✅ Migration complete', {
    documents: newDocs.length,
    totalChunks: newDocs.reduce((sum, d) => sum + d.chunkCount, 0),
  });
  for (const doc of newDocs) {
    const tagSlugs = doc.tags.map((t) => t.tag.slug).join(', ') || '(no tags)';
    logger.info(`  ${doc.chunkCount.toString().padStart(3)} chunks · ${doc.name} · [${tagSlugs}]`);
  }
  logger.info('Next: run `npm run db:seed:embeddings` to regenerate vectors.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    logger.error('Migration failed', err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
