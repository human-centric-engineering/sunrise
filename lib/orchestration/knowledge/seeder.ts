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
import { embedBatch } from './embedder';

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
 * Creates an AiKnowledgeDocument record named "Agentic Design Patterns"
 * and inserts all chunks with embedding=null. Document status is set to
 * 'ready' because the content is immediately usable by the Learning UI.
 *
 * Idempotent: skips if the document already exists with chunks.
 * If a previous attempt left a failed record with no chunks, it is
 * cleaned up and re-seeded.
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
      status: 'ready',
      uploadedBy: uploaderId,
      chunkCount: chunks.length,
    },
  });

  for (const chunk of chunks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ai_knowledge_chunk (
        id, "chunkKey", "documentId", content,
        "chunkType", "patternNumber", "patternName", category,
        section, keywords, "estimatedTokens", metadata
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3,
        $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )`,
      chunk.id,
      document.id,
      chunk.content,
      chunk.metadata.type,
      chunk.metadata.pattern_number ?? null,
      chunk.metadata.pattern_name ?? null,
      chunk.metadata.category ?? null,
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

  logger.info('Knowledge base seeded successfully (chunks only, no embeddings)', {
    documentId: document.id,
    chunkCount: chunks.length,
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
  const embeddings = await embedBatch(texts);

  for (let i = 0; i < pending.length; i++) {
    const embeddingStr = `[${embeddings[i].join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE ai_knowledge_chunk SET embedding = $1::vector WHERE id = $2`,
      embeddingStr,
      pending[i].id
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
