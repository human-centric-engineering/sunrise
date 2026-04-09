/**
 * Knowledge Base Document Manager
 *
 * Manages the lifecycle of documents in the knowledge base:
 * upload → chunk → embed → store. Handles deduplication via file hash,
 * re-chunking for document updates, and cleanup on deletion.
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { chunkMarkdownDocument } from './chunker';
import { embedBatch } from './embedder';
import type { AiKnowledgeDocument } from '@/types/prisma';

/**
 * Upload a document to the knowledge base.
 *
 * Full pipeline: create document record → chunk content → embed chunks
 * → store in database → update document status.
 *
 * @param content - Raw document content (markdown)
 * @param fileName - Original file name
 * @param userId - ID of the uploading user
 * @returns The created document record
 */
export async function uploadDocument(
  content: string,
  fileName: string,
  userId: string
): Promise<AiKnowledgeDocument> {
  const fileHash = createHash('sha256').update(content).digest('hex');
  const name = fileName.replace(/\.[^.]+$/, '');

  logger.info('Uploading document', { fileName, fileHash, userId });

  // Create document record with processing status
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      status: 'processing',
      uploadedBy: userId,
    },
  });

  try {
    // Chunk the document
    const chunks = chunkMarkdownDocument(content, name);

    if (chunks.length === 0) {
      await prisma.aiKnowledgeDocument.update({
        where: { id: document.id },
        data: { status: 'ready', chunkCount: 0 },
      });
      return document;
    }

    // Generate embeddings for all chunks
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    // Store chunks with embeddings using raw SQL for pgvector
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
        chunk.chunkType,
        chunk.patternNumber,
        chunk.patternName,
        chunk.category,
        chunk.section,
        chunk.keywords,
        chunk.estimatedTokens,
        JSON.stringify(null)
      );
    }

    // Update document status
    const updated = await prisma.aiKnowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'ready', chunkCount: chunks.length },
    });

    logger.info('Document uploaded successfully', {
      documentId: document.id,
      chunkCount: chunks.length,
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Document upload failed', { documentId: document.id, error: message });

    await prisma.aiKnowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'failed', errorMessage: message },
    });

    throw error;
  }
}

/**
 * Delete a document and all its associated chunks.
 *
 * @param documentId - ID of the document to delete
 */
export async function deleteDocument(documentId: string): Promise<void> {
  logger.info('Deleting document', { documentId });

  // Chunks are cascade-deleted via the relation
  await prisma.aiKnowledgeDocument.delete({
    where: { id: documentId },
  });

  logger.info('Document deleted', { documentId });
}

/**
 * Re-chunk and re-embed an existing document.
 *
 * Fetches the document's current chunks to reconstruct the original
 * content, deletes old chunks, then re-processes from scratch.
 * Useful when chunking strategy or embedding model changes.
 *
 * @param documentId - ID of the document to re-process
 * @returns Updated document record
 */
export async function rechunkDocument(documentId: string): Promise<AiKnowledgeDocument> {
  logger.info('Re-chunking document', { documentId });

  const document = await prisma.aiKnowledgeDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { chunks: { orderBy: { chunkKey: 'asc' } } },
  });

  // Reconstruct content from existing chunks
  const content = document.chunks.map((c) => c.content).join('\n\n---\n\n');

  // Set status to processing
  await prisma.aiKnowledgeDocument.update({
    where: { id: documentId },
    data: { status: 'processing' },
  });

  // Delete old chunks
  await prisma.aiKnowledgeChunk.deleteMany({
    where: { documentId },
  });

  try {
    // Re-chunk
    const chunks = chunkMarkdownDocument(content, document.name);

    if (chunks.length === 0) {
      return await prisma.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: 0 },
      });
    }

    // Re-embed
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    // Store new chunks
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
        documentId,
        chunk.content,
        embeddingStr,
        chunk.chunkType,
        chunk.patternNumber,
        chunk.patternName,
        chunk.category,
        chunk.section,
        chunk.keywords,
        chunk.estimatedTokens,
        JSON.stringify(null)
      );
    }

    const updated = await prisma.aiKnowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'ready', chunkCount: chunks.length },
    });

    logger.info('Document re-chunked successfully', {
      documentId,
      chunkCount: chunks.length,
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Document re-chunking failed', { documentId, error: message });

    await prisma.aiKnowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'failed', errorMessage: message },
    });

    throw error;
  }
}

/**
 * List all documents in the knowledge base with their status and chunk counts.
 *
 * @returns Array of documents ordered by creation date (newest first)
 */
export async function listDocuments(): Promise<AiKnowledgeDocument[]> {
  return prisma.aiKnowledgeDocument.findMany({
    orderBy: { createdAt: 'desc' },
  });
}
