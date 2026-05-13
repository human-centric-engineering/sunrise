/**
 * Knowledge Base Seeder
 *
 * Two-phase seeder for the knowledge base:
 *
 * Phase 1 — seedChunks(): inserts chunks from chunks.json with embedding=null
 * and creates the document with status='ready'. No external dependency.
 *
 * Phase 2 — embedChunks(): finds all chunks where embedding IS NULL, batches
 * them through the configured embedding provider, and writes vectors back.
 */

import { readFile } from 'fs/promises';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';

/** Shape of a chunk entry in the pre-parsed chunks.json */
const seedChunkMetadataSchema = z.object({
  type: z.string(),
  section: z.string().optional(),
  section_title: z.string().optional(),
  pattern_number: z.number().optional(),
  pattern_name: z.string().optional(),
  pattern_id: z.string().optional(),
  category: z.string().optional(),
  complexity: z.string().optional(),
  related_patterns: z.array(z.string()).optional(),
  keywords: z.string().optional(),
  source: z.string().optional(),
});

export const seedChunkSchema = z.object({
  id: z.string(),
  chunk_id: z.number(),
  content: z.string(),
  metadata: seedChunkMetadataSchema,
  estimated_tokens: z.number(),
});

export type SeedChunk = z.infer<typeof seedChunkSchema>;

const DOCUMENT_NAME = 'Agentic Design Patterns';
const DOCUMENT_FILE_NAME = 'agentic-design-patterns.md';

/**
 * Phase 1 — Seed chunks into the knowledge base (no embeddings).
 *
 * Creates one `AiKnowledgeDocument` named "Agentic Design Patterns" containing
 * every chunk in chunks.json (patterns + reference material). One managed
 * `KnowledgeTag` (`agentic-design-patterns`) is applied to the document via
 * the doc↔tag join, so agents in restricted-knowledge mode that hold this
 * tag can search the bundled patterns.
 *
 * History: an earlier iteration split this into one-doc-per-pattern and
 * lifted every `chunk.category` into a separate tag. That fragmented the
 * KB list into 22 rows and produced 10+ redundant tags pointing at the same
 * doc, so it was reverted — one doc, one tag.
 *
 * Idempotent: skips if the document already exists with chunks. Failed
 * seed attempts are cleaned up and re-seeded.
 *
 * @param chunksJsonPath - Absolute path to the chunks.json file
 */
export async function seedChunks(chunksJsonPath: string): Promise<void> {
  logger.info('Starting knowledge base seed (chunks only)', { chunksJsonPath });

  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: DOCUMENT_NAME },
  });

  if (existing) {
    if (existing.status === 'failed') {
      logger.info('Removing previously failed seed document', { documentId: existing.id });
      await prisma.aiKnowledgeChunk.deleteMany({ where: { documentId: existing.id } });
      await prisma.aiKnowledgeDocument.delete({ where: { id: existing.id } });
    } else {
      logger.info('Knowledge base already seeded, skipping', { documentId: existing.id });
      return;
    }
  }

  const raw = await readFile(chunksJsonPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const result = z.array(seedChunkSchema).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    throw new Error(
      `Invalid chunks.json at ${chunksJsonPath}: ${issue?.message ?? 'validation failed'} (at ${path})`
    );
  }
  const chunks = result.data;

  logger.info('Loaded chunks from file', { count: chunks.length });

  const firstAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true },
  });
  const firstUser = await prisma.user.findFirst({
    select: { id: true },
  });
  const uploaderId = firstAdmin?.id ?? firstUser?.id;

  if (!uploaderId) {
    throw new Error('No users found in database. Create a user first, then re-run the seeder.');
  }

  const { createHash } = await import('crypto');
  const contentForHash = chunks.map((c) => c.content).join('');
  const fileHash = createHash('sha256').update(contentForHash).digest('hex');

  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name: DOCUMENT_NAME,
      fileName: DOCUMENT_FILE_NAME,
      fileHash,
      scope: 'system',
      status: 'ready',
      uploadedBy: uploaderId,
      chunkCount: chunks.length,
    },
  });

  for (const chunk of chunks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ai_knowledge_chunk (
        id, "chunkKey", "documentId", content,
        "chunkType", "patternNumber", "patternName",
        section, keywords, "estimatedTokens", metadata
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3,
        $4, $5, $6, $7, $8, $9, $10::jsonb
      )`,
      chunk.id,
      document.id,
      chunk.content,
      chunk.metadata.type,
      chunk.metadata.pattern_number ?? null,
      chunk.metadata.pattern_name ?? null,
      chunk.metadata.section_title ?? chunk.metadata.section ?? null,
      chunk.metadata.keywords ?? null,
      chunk.estimated_tokens,
      JSON.stringify({
        complexity: chunk.metadata.complexity ?? null,
        relatedPatterns: chunk.metadata.related_patterns ?? null,
        patternId: chunk.metadata.pattern_id ?? null,
        source: chunk.metadata.source ?? null,
      })
    );
  }

  // Apply a single tag for the seeded patterns. We deliberately don't lift
  // every chunk.category into a separate tag — that gave us 10 redundant
  // tags all pointing at the same doc, which was the operator complaint
  // that drove the revert. One tag, one doc.
  const seedTag = await prisma.knowledgeTag.upsert({
    where: { slug: 'agentic-design-patterns' },
    create: {
      slug: 'agentic-design-patterns',
      name: 'Agentic Design Patterns',
      description:
        'Built-in reference: the 21 agentic design patterns and supporting material. Grant this tag to any agent that should be able to consult the patterns playbook.',
    },
    update: {},
  });
  await prisma.aiKnowledgeDocumentTag.upsert({
    where: { documentId_tagId: { documentId: document.id, tagId: seedTag.id } },
    create: { documentId: document.id, tagId: seedTag.id },
    update: {},
  });

  // Bidirectional safety net: grant this tag to any built-in system agent
  // that depends on the patterns knowledge (pattern-advisor, quiz-master).
  // The agent seeds also try to apply the tag — whichever order the
  // operator runs them, the grant ends up present. Idempotent.
  const systemAgents = await prisma.aiAgent.findMany({
    where: { slug: { in: ['pattern-advisor', 'quiz-master'] } },
    select: { id: true, slug: true },
  });
  for (const agent of systemAgents) {
    await prisma.aiAgentKnowledgeTag.upsert({
      where: { agentId_tagId: { agentId: agent.id, tagId: seedTag.id } },
      create: { agentId: agent.id, tagId: seedTag.id },
      update: {},
    });
  }
  if (systemAgents.length > 0) {
    logger.info('Granted patterns tag to system agents', {
      slugs: systemAgents.map((a) => a.slug),
    });
  }

  // Record the seed timestamp on the settings singleton (upsert to handle
  // the case where settings haven't been lazily created yet).
  await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: { slug: 'global', defaultModels: {}, lastSeededAt: new Date() },
    update: { lastSeededAt: new Date() },
  });

  logger.info('Knowledge base seeded successfully (chunks only, no embeddings)', {
    documentId: document.id,
    chunkCount: chunks.length,
    tag: 'agentic-design-patterns',
  });
}

/**
 * Phase 2 — Generate embeddings for all unembedded chunks.
 *
 * Finds every chunk where embedding IS NULL, batches them through the
 * configured embedding provider, and writes vectors back. Can be called
 * repeatedly — only processes chunks that still need embeddings.
 *
 * @returns Summary of what was processed
 */
export async function embedChunks(): Promise<{
  processed: number;
  total: number;
  alreadyEmbedded: number;
}> {
  const total = await prisma.aiKnowledgeChunk.count();

  const pending = await prisma.$queryRawUnsafe<Array<{ id: string; content: string }>>(
    `SELECT id, content FROM ai_knowledge_chunk WHERE embedding IS NULL ORDER BY id`
  );

  if (pending.length === 0) {
    logger.info('All chunks already embedded', { total });
    return { processed: 0, total, alreadyEmbedded: total };
  }

  logger.info('Starting embedding generation', {
    pending: pending.length,
    total,
  });

  const texts = pending.map((c) => c.content);
  const { embeddings, provenance } = await embedBatch(texts);

  for (let i = 0; i < pending.length; i++) {
    const embeddingStr = `[${embeddings[i].join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE ai_knowledge_chunk
       SET embedding = $1::vector,
           "embeddingModel" = $3,
           "embeddingProvider" = $4,
           "embeddedAt" = $5
       WHERE id = $2`,
      embeddingStr,
      pending[i].id,
      provenance.model,
      provenance.provider,
      provenance.embeddedAt
    );
  }

  const alreadyEmbedded = total - pending.length;
  logger.info('Embedding generation complete', {
    processed: pending.length,
    total,
    alreadyEmbedded,
  });

  return { processed: pending.length, total, alreadyEmbedded };
}
