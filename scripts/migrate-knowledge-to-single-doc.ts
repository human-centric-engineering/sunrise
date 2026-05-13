import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import path from 'path';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';

/**
 * Reverse migration: roll the seeded Agentic Design Patterns knowledge back
 * from the per-pattern layout (22 docs, 10 chunk-category tags) into a single
 * "Agentic Design Patterns" document with a single "agentic-design-patterns"
 * tag.
 *
 * Background: the per-pattern split was intended to make chunk-level
 * categories scope agent access. In practice it fragmented the document list
 * into 22 rows ("Pattern 1: Prompt Chaining", "Pattern 2: Routing", …) and
 * surfaced 10 tags that the operator never asked for. Easier to scope: keep
 * the seeded content as one doc carrying one tag; operators can apply that
 * tag to other docs and grant it to specific agents.
 *
 * What this script deletes:
 *   - Every AiKnowledgeDocument with scope='system' and a fileName starting
 *     with "agentic-design-patterns-" (the 22 per-pattern docs).
 *   - The legacy single doc named "Agentic Design Patterns" if any (we want
 *     a fresh seed so the new tag wiring lands cleanly).
 *   - Every chunk-category KnowledgeTag created by the previous seeder runs
 *     and the backfill script: anything matching the 11 known slugs below
 *     AND with zero agent grants. Agent-granted tags are left alone — the
 *     operator wired them up deliberately.
 *
 * What it creates:
 *   - One "Agentic Design Patterns" document via the seeder (single-doc mode).
 *   - One "agentic-design-patterns" tag, applied to the doc.
 *
 * Cost: embeddings on the deleted chunks are lost. Re-run
 * `npm run db:seed:embeddings` afterwards to regenerate.
 *
 * Idempotent: a second run on the resulting clean state is a no-op (the
 * seeder bails when the single doc already exists).
 */

// Slugs of the chunk-category tags the per-pattern seeder produced. These get
// pruned only if no agent currently grants them — agent-bound tags survive.
const CHUNK_CATEGORY_TAG_SLUGS = [
  'architecture',
  'core-workflow',
  'external-integration',
  'orchestration',
  'production-operations',
  'quality-assurance',
  'reference',
  'reliability',
  'safety-oversight',
  'self-improvement',
  'state-data',
];

async function main(): Promise<void> {
  logger.info('🔁 Reverting knowledge to single-document layout');

  // 1. Drop every per-pattern doc. CASCADE removes chunks + doc-tag links.
  const perPattern = await prisma.aiKnowledgeDocument.findMany({
    where: {
      scope: 'system',
      fileName: { startsWith: 'agentic-design-patterns-' },
    },
    select: { id: true, name: true },
  });
  if (perPattern.length > 0) {
    logger.info(`Deleting ${perPattern.length} per-pattern documents`);
    for (const doc of perPattern) {
      logger.info(`  · ${doc.name}`);
    }
    await prisma.aiKnowledgeDocument.deleteMany({
      where: { id: { in: perPattern.map((d) => d.id) } },
    });
  } else {
    logger.info('No per-pattern documents found');
  }

  // 2. Drop the legacy single doc too if any — the seeder will recreate it
  // with the right tag wiring. Embeddings on those chunks would be lost
  // anyway since we're re-seeding the content.
  const legacy = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: 'Agentic Design Patterns', scope: 'system' },
    select: { id: true, chunkCount: true },
  });
  if (legacy) {
    logger.info(`Deleting legacy single-doc (chunkCount=${legacy.chunkCount})`);
    await prisma.aiKnowledgeDocument.delete({ where: { id: legacy.id } });
  }

  // 3. Prune chunk-category tags that aren't granted to any agent. Any tag
  // an operator wired up to an agent stays — that's a deliberate choice we
  // shouldn't override.
  for (const slug of CHUNK_CATEGORY_TAG_SLUGS) {
    const tag = await prisma.knowledgeTag.findUnique({
      where: { slug },
      include: { _count: { select: { agents: true, documents: true } } },
    });
    if (!tag) continue;
    if (tag._count.agents > 0) {
      logger.warn(
        `Tag "${slug}" has ${tag._count.agents} agent grant(s) — keeping it. Operator can delete from the Tags admin if they want.`
      );
      continue;
    }
    await prisma.knowledgeTag.delete({ where: { id: tag.id } });
    logger.info(`  Pruned unused tag "${slug}"`);
  }

  // 4. Re-seed single-doc layout.
  const chunksPath = path.resolve(
    process.cwd(),
    'prisma',
    'seeds',
    'data',
    'chunks',
    'chunks.json'
  );
  await seedChunks(chunksPath);

  // 5. Final report.
  const doc = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: 'Agentic Design Patterns', scope: 'system' },
    include: { tags: { include: { tag: { select: { slug: true, name: true } } } } },
  });
  if (doc) {
    logger.info('✅ Single-doc layout restored', {
      documentId: doc.id,
      chunkCount: doc.chunkCount,
      tags: doc.tags.map((t) => t.tag.slug),
    });
  }
  logger.info('Next: run `npm run db:seed:embeddings` to regenerate vectors.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    logger.error('Reverse migration failed', err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
