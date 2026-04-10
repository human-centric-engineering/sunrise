/**
 * Knowledge Base Seeder
 *
 * Seeds the knowledge base from the pre-parsed chunks.json file.
 * Creates an AiKnowledgeDocument record and links all chunks to it.
 * Used for initial setup of the agentic design patterns knowledge base.
 */

import { readFile } from 'fs/promises';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedBatch } from './embedder';

/** Shape of a chunk entry in the pre-parsed chunks.json */
interface SeedChunk {
  id: string;
  chunk_id: number;
  content: string;
  metadata: {
    type: string;
    section?: string;
    section_title?: string;
    pattern_number?: number;
    pattern_name?: string;
    pattern_id?: string;
    category?: string;
    complexity?: string;
    related_patterns?: string[];
    keywords?: string;
    source?: string;
  };
  estimated_tokens: number;
}

const DOCUMENT_NAME = 'Agentic Design Patterns';
const DOCUMENT_FILE_NAME = 'agentic-design-patterns.md';

/**
 * Seed the knowledge base from a pre-parsed chunks.json file.
 *
 * Creates an AiKnowledgeDocument record named "Agentic Design Patterns"
 * and inserts all chunks with embeddings. Skips if the document already
 * exists (idempotent).
 *
 * @param chunksJsonPath - Absolute path to the chunks.json file
 */
export async function seedFromChunksJson(chunksJsonPath: string): Promise<void> {
  logger.info('Starting knowledge base seed', { chunksJsonPath });

  // Check if already seeded
  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: DOCUMENT_NAME },
  });

  if (existing) {
    logger.info('Knowledge base already seeded, skipping', { documentId: existing.id });
    return;
  }

  // Read and parse chunks.json
  const raw = await readFile(chunksJsonPath, 'utf-8');
  const chunks = JSON.parse(raw) as SeedChunk[];

  logger.info('Loaded chunks from file', { count: chunks.length });

  // Create the document record
  // Use the first available user as the uploader, or a system placeholder
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

  // Compute a hash from the content
  const { createHash } = await import('crypto');
  const contentForHash = chunks.map((c) => c.content).join('');
  const fileHash = createHash('sha256').update(contentForHash).digest('hex');

  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name: DOCUMENT_NAME,
      fileName: DOCUMENT_FILE_NAME,
      fileHash,
      status: 'processing',
      uploadedBy: uploaderId,
    },
  });

  try {
    // Generate embeddings in batches
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    // Insert chunks with embeddings
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embeddingStr = `[${embeddings[i].join(',')}]`;

      await prisma.$executeRawUnsafe(
        `INSERT INTO ai_knowledge_chunk (
          id, "chunkKey", "documentId", content, embedding,
          "chunkType", "patternNumber", "patternName", category,
          section, keywords, "estimatedTokens", metadata
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4::vector,
          $5, $6, $7, $8, $9, $10, $11, $12::jsonb
        )`,
        chunk.id,
        document.id,
        chunk.content,
        embeddingStr,
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

    // Update document status
    await prisma.aiKnowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'ready', chunkCount: chunks.length },
    });

    logger.info('Knowledge base seeded successfully', {
      documentId: document.id,
      chunkCount: chunks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Knowledge base seeding failed', { documentId: document.id, error: message });

    await prisma.aiKnowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'failed', errorMessage: message },
    });

    throw error;
  }
}
