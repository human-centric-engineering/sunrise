/**
 * Knowledge Base Document Manager
 *
 * Manages the lifecycle of documents in the knowledge base:
 * upload → chunk → embed → store. Handles deduplication via file hash,
 * re-chunking for document updates, and cleanup on deletion.
 */

import { createHash } from 'crypto';
import { extname } from 'path';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  chunkMarkdownDocument,
  parseMetadataComments,
} from '@/lib/orchestration/knowledge/chunker';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import { parseDocument, requiresPreview } from '@/lib/orchestration/knowledge/parsers';
import type { AiKnowledgeDocument } from '@/types/prisma';

/**
 * Extract a document-level category from metadata comments.
 * Looks for `<!-- metadata: category=... -->` at the top level.
 */
function extractDocumentCategory(content: string): string | null {
  const meta = parseMetadataComments(content);
  return meta['category'] || null;
}

/**
 * Upload a document to the knowledge base.
 *
 * Full pipeline: create document record → chunk content → embed chunks
 * → store in database → update document status.
 *
 * @param content - Raw document content (markdown)
 * @param fileName - Original file name
 * @param userId - ID of the uploading user
 * @param category - Optional category (overrides any in-document metadata)
 * @returns The created document record
 */
export async function uploadDocument(
  content: string,
  fileName: string,
  userId: string,
  category?: string
): Promise<AiKnowledgeDocument> {
  const fileHash = createHash('sha256').update(content).digest('hex');
  const name = fileName.replace(/\.[^.]+$/, '');

  logger.info('Uploading document', { fileName, fileHash, userId });

  // Deduplicate: return an existing 'ready' document with the same content hash.
  // Previously-failed uploads are intentionally not returned so the caller can retry.
  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { fileHash, status: 'ready' },
  });
  if (existing) {
    logger.info('Document already uploaded, returning existing', {
      documentId: existing.id,
      fileHash,
    });
    return existing;
  }

  // Resolve category: explicit param → document-level metadata → null
  const resolvedCategory = category || extractDocumentCategory(content) || null;

  // Create document record with processing status
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      scope: 'app',
      category: resolvedCategory,
      status: 'processing',
      uploadedBy: userId,
    },
  });

  try {
    // Chunk the document
    const chunks = chunkMarkdownDocument(content, name);

    // If a document-level category was set, apply it to chunks that have none
    if (resolvedCategory) {
      for (const chunk of chunks) {
        if (!chunk.category) {
          chunk.category = resolvedCategory;
        }
      }
    }

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
 * Upload a document from a raw file buffer (multi-format).
 *
 * Detects the format from the file extension, parses the content, then
 * routes through the standard chunk → embed → store pipeline.
 *
 * For formats that require preview (PDF), use `previewDocument` +
 * `confirmPreview` instead.
 *
 * @param buffer - Raw file content
 * @param fileName - Original file name (extension determines parser)
 * @param userId - ID of the uploading user
 * @param category - Optional category override
 * @returns The created document record
 * @throws Error if the format requires preview (use previewDocument instead)
 */
export async function uploadDocumentFromBuffer(
  buffer: Buffer,
  fileName: string,
  userId: string,
  category?: string
): Promise<AiKnowledgeDocument> {
  if (requiresPreview(fileName)) {
    throw new Error(
      `Format "${extname(fileName)}" requires a preview step. Use previewDocument() + confirmPreview() instead.`
    );
  }

  const parsed = await parseDocument(buffer, fileName);

  if (parsed.warnings.length > 0) {
    logger.warn('Document parsed with warnings', {
      fileName,
      warnings: parsed.warnings,
    });
  }

  // For markdown files, use the raw text directly (the markdown chunker
  // handles structural splitting). For other formats, use the full text
  // which has been normalized to plain text.
  const ext = extname(fileName).toLowerCase();
  const content = ext === '.md' ? buffer.toString('utf-8') : parsed.fullText;

  return uploadDocument(content, fileName, userId, category);
}

/** Result of a document preview (parse-only, no chunking/embedding). */
export interface DocumentPreview {
  /** The document record (status = 'pending_review'). */
  document: AiKnowledgeDocument;
  /** Extracted text content for admin review. */
  extractedText: string;
  /** Document title from metadata. */
  title: string;
  /** Author if available. */
  author?: string;
  /** Number of sections detected. */
  sectionCount: number;
  /** Parsing warnings. */
  warnings: string[];
}

/**
 * Parse a document for preview without chunking or embedding.
 *
 * Creates a document record with status 'pending_review' and returns
 * the extracted text for the admin to review. Call `confirmPreview()`
 * with the document ID to proceed with chunking + embedding.
 *
 * Primarily used for PDF uploads where parsing is unreliable.
 *
 * @param buffer - Raw file content
 * @param fileName - Original file name
 * @param userId - ID of the uploading user
 * @returns Preview result with extracted text and metadata
 */
export async function previewDocument(
  buffer: Buffer,
  fileName: string,
  userId: string
): Promise<DocumentPreview> {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const name = fileName.replace(/\.[^.]+$/, '');

  const parsed = await parseDocument(buffer, fileName);

  // Create document record in pending_review status
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      scope: 'app',
      status: 'pending_review',
      uploadedBy: userId,
      metadata: {
        extractedText: parsed.fullText,
        parsedTitle: parsed.title,
        parsedAuthor: parsed.author ?? null,
        sectionCount: parsed.sections.length,
        warnings: parsed.warnings,
      },
    },
  });

  logger.info('Document preview created', {
    documentId: document.id,
    fileName,
    textLength: parsed.fullText.length,
    sections: parsed.sections.length,
    warnings: parsed.warnings.length,
  });

  return {
    document,
    extractedText: parsed.fullText,
    title: parsed.title,
    author: parsed.author,
    sectionCount: parsed.sections.length,
    warnings: parsed.warnings,
  };
}

/**
 * Confirm a previewed document and proceed with chunking + embedding.
 *
 * @param documentId - ID of the document in 'pending_review' status
 * @param userId - ID of the confirming user (must match the uploader)
 * @param correctedContent - Optional corrected text to replace the parsed content
 * @param category - Optional category override
 * @returns The updated document record (status = 'ready')
 */
export async function confirmPreview(
  documentId: string,
  userId: string,
  correctedContent?: string,
  category?: string
): Promise<AiKnowledgeDocument> {
  const document = await prisma.aiKnowledgeDocument.findFirst({
    where: { id: documentId, uploadedBy: userId, status: 'pending_review' },
  });

  if (!document) {
    throw new Error(
      `Document ${documentId} not found, not owned by this user, or not in pending_review status`
    );
  }

  const metadata = document.metadata as Record<string, unknown> | null;
  const extractedText = metadata?.extractedText as string | undefined;
  const content = correctedContent || extractedText || '';

  if (!content.trim()) {
    throw new Error('No content available to chunk. Provide correctedContent or re-upload.');
  }

  logger.info('Confirming document preview', {
    documentId,
    usedCorrectedContent: !!correctedContent,
    contentLength: content.length,
  });

  // Use the standard upload pipeline from here
  // First update status to processing
  await prisma.aiKnowledgeDocument.update({
    where: { id: documentId },
    data: { status: 'processing', category: category ?? document.category },
  });

  try {
    const chunks = chunkMarkdownDocument(content, document.name);

    if (category) {
      for (const chunk of chunks) {
        if (!chunk.category) {
          chunk.category = category;
        }
      }
    }

    if (chunks.length === 0) {
      return await prisma.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: 0 },
      });
    }

    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

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
      data: {
        status: 'ready',
        chunkCount: chunks.length,
        metadata: { format: extname(document.fileName).toLowerCase() },
      },
    });

    logger.info('Document preview confirmed and processed', {
      documentId,
      chunkCount: chunks.length,
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Document confirm failed', { documentId, error: message });

    await prisma.aiKnowledgeDocument.update({
      where: { id: documentId },
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

  if (document.chunks.length === 0) {
    logger.warn('Rechunk skipped: document has no existing chunks to reconstruct from', {
      documentId,
    });
    const { chunks: _chunks, ...rest } = document;
    return rest;
  }

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

/** A single meta-tag value with usage count */
export interface MetaTagEntry {
  value: string;
  chunkCount: number;
  documentCount: number;
}

/** Meta-tags for a single scope (app or system) */
export interface ScopedMetaTags {
  categories: MetaTagEntry[];
  keywords: MetaTagEntry[];
}

/** Summary of all meta-tags grouped by knowledge base scope */
export interface MetaTagSummary {
  app: ScopedMetaTags;
  system: ScopedMetaTags;
}

interface RawTagRow {
  scope: string;
  value: string;
  chunk_count: bigint;
  doc_count: bigint;
}

function mapTagRows(rows: RawTagRow[]): { app: MetaTagEntry[]; system: MetaTagEntry[] } {
  const app: MetaTagEntry[] = [];
  const system: MetaTagEntry[] = [];
  for (const r of rows) {
    const entry = {
      value: r.value.trim(),
      chunkCount: Number(r.chunk_count),
      documentCount: Number(r.doc_count),
    };
    if (r.scope === 'system') {
      system.push(entry);
    } else {
      app.push(entry);
    }
  }
  return { app, system };
}

/**
 * List all distinct meta-tag values (categories and keywords) across chunks,
 * grouped by document scope (app vs system), with chunk and document counts.
 */
export async function listMetaTags(): Promise<MetaTagSummary> {
  const [categoryRows, keywordRows] = await Promise.all([
    prisma.$queryRaw<RawTagRow[]>`
      SELECT d.scope, c.category AS value,
             COUNT(*)::bigint AS chunk_count,
             COUNT(DISTINCT c."documentId")::bigint AS doc_count
      FROM ai_knowledge_chunk c
      JOIN ai_knowledge_document d ON d.id = c."documentId"
      WHERE c.category IS NOT NULL AND c.category <> ''
      GROUP BY d.scope, c.category
      ORDER BY chunk_count DESC
    `,
    prisma.$queryRaw<RawTagRow[]>`
      SELECT d.scope, kw AS value,
             COUNT(*)::bigint AS chunk_count,
             COUNT(DISTINCT c."documentId")::bigint AS doc_count
      FROM ai_knowledge_chunk c
      JOIN ai_knowledge_document d ON d.id = c."documentId",
           LATERAL unnest(string_to_array(c.keywords, ',')) AS kw
      WHERE c.keywords IS NOT NULL AND c.keywords <> ''
      GROUP BY d.scope, kw
      ORDER BY chunk_count DESC
    `,
  ]);

  const cats = mapTagRows(categoryRows);
  const kws = mapTagRows(keywordRows);

  return {
    app: { categories: cats.app, keywords: kws.app },
    system: { categories: cats.system, keywords: kws.system },
  };
}
