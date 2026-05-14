/**
 * Knowledge Base Document Manager
 *
 * Manages the lifecycle of documents in the knowledge base:
 * upload → chunk → embed → store. Handles deduplication via file hash,
 * re-chunking for document updates, and cleanup on deletion.
 */

import { createHash } from 'crypto';
import { extname } from 'path';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import {
  chunkCsvDocument,
  chunkMarkdownDocument,
  CSV_MAX_ROW_CHARS,
} from '@/lib/orchestration/knowledge/chunker';
import type { Chunk } from '@/lib/orchestration/knowledge/chunker';
import { buildCoverageWarning, computeCoverage } from '@/lib/orchestration/knowledge/coverage';
import type { ParsedDocument } from '@/lib/orchestration/knowledge/parsers/types';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import type { EmbeddingProvenance } from '@/lib/orchestration/knowledge/embedder';
import {
  parseDocument,
  requiresPreview,
  type ParseDocumentOptions,
} from '@/lib/orchestration/knowledge/parsers';
import type { AiKnowledgeDocument } from '@/types/prisma';

/**
 * Seed-managed default knowledge base. Every document belongs to exactly
 * one KB; until the admin UI picker lands (Phase 6), all uploads route
 * here. See migration `flexible_embedding_models_and_kb_grouping`.
 */
export const DEFAULT_KNOWLEDGE_BASE_ID = 'kb_default';

/** A single CSV row persisted on the document for lossless re-chunking. */
const csvSectionSchema = z.object({
  title: z.string(),
  content: z.string(),
  order: z.number(),
});

/** Schema for document metadata stored as Prisma JSON field */
const documentMetadataSchema = z
  .object({
    rawContent: z.string().optional(),
    extractedText: z.string().optional(),
    parsedTitle: z.string().nullable().optional(),
    parsedAuthor: z.string().nullable().optional(),
    sectionCount: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    format: z.string().optional(),
    corrected: z.boolean().optional(),
    /**
     * CSV-only. Persisted at upload so re-chunk can rebuild the exact same
     * sections without round-tripping through a `\n`-joined string (which
     * would fragment any RFC-4180 quoted cell that contains an embedded
     * newline). See `rechunkDocument` for the consuming path.
     */
    csvSections: z.array(csvSectionSchema).optional(),
    /**
     * Per-page diagnostics written by the PDF parser at preview time.
     * Surfaced in the PDF preview modal as a page-coverage bar strip.
     */
    pages: z
      .array(
        z.object({
          num: z.number(),
          charCount: z.number(),
          hasText: z.boolean(),
        })
      )
      .nullable()
      .optional(),
    /**
     * Text-capture coverage written at chunk time. parsedChars / chunkChars
     * are byte counts after trimming; coveragePct is chunkChars / parsedChars
     * × 100, can exceed 100 because heading-aware chunking re-emits titles.
     * Used by the admin UI to assure the operator that all source text was
     * captured. See `lib/orchestration/knowledge/coverage.ts`.
     */
    coverage: z
      .object({
        parsedChars: z.number(),
        chunkChars: z.number(),
        coveragePct: z.number(),
      })
      .optional(),
  })
  .passthrough()
  .nullable();

/** Safely parse document metadata from Prisma JSON field */
export function parseDocumentMetadata(raw: unknown) {
  const result = documentMetadataSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Transaction client type used by insertChunks */
type TxClient = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/**
 * Insert chunks with embeddings into the database using raw SQL for pgvector.
 * Extracted from the three callers (upload, confirm, rechunk) that all had
 * identical 15-parameter INSERT statements.
 *
 * Accepts a transaction client so all inserts are atomic — if any chunk
 * fails, the entire batch is rolled back (no partial chunk data).
 */
async function insertChunks(
  tx: TxClient,
  documentId: string,
  chunks: Chunk[],
  embeddings: number[][],
  provenance: EmbeddingProvenance
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embeddingStr = `[${embeddings[i].join(',')}]`;

    await tx.$executeRawUnsafe(
      `INSERT INTO ai_knowledge_chunk (
        id, "chunkKey", "documentId", content, embedding,
        "chunkType", "patternNumber", "patternName",
        section, keywords, "estimatedTokens", metadata,
        "embeddingModel", "embeddingProvider", "embeddedAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4::vector,
        $5, $6, $7, $8, $9, $10, $11::jsonb,
        $12, $13, $14
      )`,
      chunk.id,
      documentId,
      chunk.content,
      embeddingStr,
      chunk.chunkType,
      chunk.patternNumber,
      chunk.patternName,
      chunk.section,
      chunk.keywords,
      chunk.estimatedTokens,
      JSON.stringify(null),
      provenance.model,
      provenance.provider,
      provenance.embeddedAt
    );
  }
}

/**
 * Reconstruct a `ParsedDocument` from the per-row sections persisted on a CSV
 * document's `metadata.csvSections`. Used by `rechunkDocument` so CSVs route
 * through `chunkCsvDocument` instead of the markdown chunker, with each
 * stored row re-emitted verbatim — including any embedded newlines that
 * survived inside RFC-4180 quoted cells.
 */
function rebuildCsvParsedFromSections(
  sections: ReadonlyArray<{ title: string; content: string; order: number }>,
  name: string
): ParsedDocument {
  return {
    title: name,
    sections: sections.map((s) => ({ title: s.title, content: s.content, order: s.order })),
    fullText: sections.map((s) => s.content).join('\n'),
    metadata: { format: 'csv' },
    warnings: [],
  };
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
 * @returns The created document record
 */
export async function uploadDocument(
  content: string,
  fileName: string,
  userId: string,
  sourceUrl?: string,
  displayName?: string
): Promise<AiKnowledgeDocument> {
  const fileHash = createHash('sha256').update(content).digest('hex');
  // Use the operator-supplied display name when present; otherwise fall back
  // to the filename without extension.
  const fallbackName = fileName.replace(/\.[^.]+$/, '');
  const name = displayName?.trim() || fallbackName;

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

  // Create document record with processing status
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      scope: 'app',
      sourceUrl: sourceUrl ?? null,
      status: 'processing',
      uploadedBy: userId,
      knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
    },
  });

  try {
    // Chunk the document
    const chunks = await chunkMarkdownDocument(content, name, document.id);

    if (chunks.length === 0) {
      await prisma.aiKnowledgeDocument.update({
        where: { id: document.id },
        data: { status: 'ready', chunkCount: 0 },
      });
      return document;
    }

    // Generate embeddings (external API call — kept outside transaction)
    const texts = chunks.map((c) => c.content);
    const { embeddings, provenance } = await embedBatch(texts);

    const coverage = computeCoverage(content, texts);
    const coverageWarning = buildCoverageWarning(coverage);
    const warnings = coverageWarning ? [coverageWarning] : [];

    // Insert chunks + update status atomically
    const updated = await executeTransaction(async (tx) => {
      await insertChunks(tx, document.id, chunks, embeddings, provenance);
      return await tx.aiKnowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
          metadata: { rawContent: content, coverage, warnings },
        },
      });
    });

    logger.info('Document uploaded successfully', {
      documentId: document.id,
      chunkCount: chunks.length,
      coveragePct: coverage.coveragePct,
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
 * @returns The created document record
 * @throws Error if the format requires preview (use previewDocument instead)
 */
export async function uploadDocumentFromBuffer(
  buffer: Buffer,
  fileName: string,
  userId: string,
  sourceUrl?: string,
  displayName?: string
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

  // CSV uses row-level chunking via chunkCsvDocument (not the markdown
  // chunker), so it bypasses uploadDocument and runs the full lifecycle here.
  if (parsed.metadata.format === 'csv') {
    return uploadCsvFromParsed(parsed, buffer, fileName, userId, sourceUrl, displayName);
  }

  // For markdown files, use the raw text directly (the markdown chunker
  // handles structural splitting). For other formats, use the full text
  // which has been normalized to plain text.
  const ext = extname(fileName).toLowerCase();
  const content = ext === '.md' ? buffer.toString('utf-8') : parsed.fullText;

  return uploadDocument(content, fileName, userId, sourceUrl, displayName);
}

/**
 * Upload a parsed CSV through the chunk → embed → store pipeline.
 *
 * Mirrors `uploadDocument` but calls `chunkCsvDocument` instead of the
 * markdown chunker so each row stays atomic for retrieval. Persists CSV
 * structural metadata (delimiter, row/column count, header detection) on
 * the document so downstream UIs can render it.
 */
async function uploadCsvFromParsed(
  parsed: ParsedDocument,
  buffer: Buffer,
  fileName: string,
  userId: string,
  sourceUrl?: string,
  displayName?: string
): Promise<AiKnowledgeDocument> {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const fallbackName = fileName.replace(/\.[^.]+$/, '');
  const name = displayName?.trim() || fallbackName;

  logger.info('Uploading CSV document', { fileName, fileHash, userId });

  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { fileHash, status: 'ready' },
  });
  if (existing) {
    logger.info('CSV already uploaded, returning existing', {
      documentId: existing.id,
      fileHash,
    });
    return existing;
  }

  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      scope: 'app',
      sourceUrl: sourceUrl ?? null,
      status: 'processing',
      uploadedBy: userId,
      knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
    },
  });

  try {
    // Drop any row whose content would blow past every embedding API's input
    // limit (≈ 8k tokens). One bad row used to fail the whole upload with an
    // opaque API error; now we skip it, name it in the warnings, and process
    // the rest. This is one-way: we never split a CSV row across chunks
    // because that would defeat row-atomic retrieval.
    const oversize: number[] = [];
    const acceptableSections = parsed.sections.filter((s, i) => {
      if (s.content.length > CSV_MAX_ROW_CHARS) {
        oversize.push(i + 1);
        return false;
      }
      return true;
    });
    if (oversize.length > 0) {
      const sample = oversize.slice(0, 5).join(', ');
      const suffix = oversize.length > 5 ? `, … (${oversize.length} total)` : '';
      const message =
        `Skipped ${oversize.length} row(s) over the ${CSV_MAX_ROW_CHARS.toLocaleString()}-character ` +
        `embedding limit: row${oversize.length === 1 ? '' : 's'} ${sample}${suffix}. ` +
        `Check whether a single cell contains a binary blob or a multi-line JSON payload.`;
      parsed.warnings.push(message);
      logger.warn('CSV upload: skipped oversize rows', {
        fileName,
        skippedCount: oversize.length,
        sampleRows: oversize.slice(0, 5),
      });
    }

    const filteredParsed = { ...parsed, sections: acceptableSections };
    const chunks = chunkCsvDocument(filteredParsed, name, document.id);

    // Persist the parsed sections verbatim. Re-chunking reads this back
    // (see `rechunkDocument`) instead of `split('\n')`-ing a joined string,
    // which would shred any RFC-4180 quoted cell containing an embedded
    // newline. Sections carry their own ordering hint so we don't depend on
    // array position once stored.
    const csvSections = acceptableSections.map((s, i) => ({
      title: s.title,
      content: s.content,
      order: s.order ?? i,
    }));

    if (chunks.length === 0) {
      await prisma.aiKnowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: 'ready',
          chunkCount: 0,
          metadata: {
            format: 'csv',
            rawContent: parsed.fullText,
            delimiter: parsed.metadata.delimiter,
            rowCount: parsed.metadata.rowCount,
            columnCount: parsed.metadata.columnCount,
            hasHeader: parsed.metadata.hasHeader,
            warnings: parsed.warnings,
            csvSections,
          },
        },
      });
      return document;
    }

    const texts = chunks.map((c) => c.content);
    const { embeddings, provenance } = await embedBatch(texts);

    // Coverage is computed against the post-filter section text — the
    // oversize-row skip warning above already accounts for dropped rows.
    // Comparing against `parsed.fullText` would double-count that loss.
    const acceptableText = acceptableSections.map((s) => s.content).join('\n');
    const coverage = computeCoverage(acceptableText, texts);
    const coverageWarning = buildCoverageWarning(coverage);
    if (coverageWarning) parsed.warnings.push(coverageWarning);

    const updated = await executeTransaction(async (tx) => {
      await insertChunks(tx, document.id, chunks, embeddings, provenance);
      return await tx.aiKnowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
          metadata: {
            format: 'csv',
            rawContent: parsed.fullText,
            delimiter: parsed.metadata.delimiter,
            rowCount: parsed.metadata.rowCount,
            columnCount: parsed.metadata.columnCount,
            hasHeader: parsed.metadata.hasHeader,
            warnings: parsed.warnings,
            csvSections,
            coverage,
          },
        },
      });
    });

    logger.info('CSV uploaded successfully', {
      documentId: document.id,
      chunkCount: chunks.length,
      rowCount: parsed.metadata.rowCount,
      coveragePct: coverage.coveragePct,
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('CSV upload failed', { documentId: document.id, error: message });

    await prisma.aiKnowledgeDocument.update({
      where: { id: document.id },
      data: { status: 'failed', errorMessage: message },
    });

    throw error;
  }
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
 * **Dedup behaviour.** If the same user already has a pending_review row
 * for this exact file (same SHA-256 hash), the existing row is refreshed in
 * place with the latest parse result rather than a second row being created.
 * This keeps the admin queue clean when an admin abandons a preview and
 * re-uploads the same file (e.g. to retry with `extractTables`). Dedup is
 * scoped to the uploading user so two admins independently triaging the
 * same source material don't clobber each other.
 *
 * @param buffer - Raw file content
 * @param fileName - Original file name
 * @param userId - ID of the uploading user
 * @returns Preview result with extracted text and metadata
 */
export async function previewDocument(
  buffer: Buffer,
  fileName: string,
  userId: string,
  opts: ParseDocumentOptions = {}
): Promise<DocumentPreview> {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const name = fileName.replace(/\.[^.]+$/, '');

  const parsed = await parseDocument(buffer, fileName, opts);

  const previewMetadata = {
    extractedText: parsed.fullText,
    parsedTitle: parsed.title,
    parsedAuthor: parsed.author ?? null,
    sectionCount: parsed.sections.length,
    warnings: parsed.warnings,
    pages: parsed.pageInfo
      ? parsed.pageInfo.map((p) => ({
          num: p.num,
          charCount: p.charCount,
          hasText: p.hasText,
        }))
      : null,
  };

  // Reuse an existing pending_review row for the same file + uploader so a
  // re-upload (typically: admin abandoned a preview, then tried again with
  // extractTables, or fixed a typo in the source PDF) refreshes the parse in
  // place instead of leaving stale rows in the queue.
  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { fileHash, uploadedBy: userId, status: 'pending_review' },
  });

  if (existing) {
    const refreshed = await prisma.aiKnowledgeDocument.update({
      where: { id: existing.id },
      data: {
        // The bytes match by hash, but the file may have been re-named in the
        // OS — keep the most recent name so the admin sees what they uploaded.
        name,
        fileName,
        metadata: previewMetadata,
      },
    });
    logger.info('Refreshed existing PDF preview', {
      documentId: refreshed.id,
      fileName,
      textLength: parsed.fullText.length,
      sections: parsed.sections.length,
      warnings: parsed.warnings.length,
    });
    return {
      document: refreshed,
      extractedText: parsed.fullText,
      title: parsed.title,
      author: parsed.author,
      sectionCount: parsed.sections.length,
      warnings: parsed.warnings,
    };
  }

  // Create document record in pending_review status
  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name,
      fileName,
      fileHash,
      scope: 'app',
      status: 'pending_review',
      uploadedBy: userId,
      knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
      metadata: {
        extractedText: parsed.fullText,
        parsedTitle: parsed.title,
        parsedAuthor: parsed.author ?? null,
        sectionCount: parsed.sections.length,
        warnings: parsed.warnings,
        pages: parsed.pageInfo
          ? parsed.pageInfo.map((p) => ({
              num: p.num,
              charCount: p.charCount,
              hasText: p.hasText,
            }))
          : null,
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
 * @returns The updated document record (status = 'ready')
 */
export async function confirmPreview(
  documentId: string,
  userId: string,
  correctedContent?: string
): Promise<AiKnowledgeDocument> {
  const document = await prisma.aiKnowledgeDocument.findFirst({
    where: { id: documentId, uploadedBy: userId, status: 'pending_review' },
  });

  if (!document) {
    throw new Error(
      `Document ${documentId} not found, not owned by this user, or not in pending_review status`
    );
  }

  const metadata = parseDocumentMetadata(document.metadata);
  const extractedText = metadata?.extractedText;
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
    data: { status: 'processing' },
  });

  try {
    const chunks = await chunkMarkdownDocument(content, document.name, documentId);

    if (chunks.length === 0) {
      return await prisma.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: 0 },
      });
    }

    const texts = chunks.map((c) => c.content);
    const { embeddings, provenance } = await embedBatch(texts);

    const coverage = computeCoverage(content, texts);
    const coverageWarning = buildCoverageWarning(coverage);
    const parserWarnings = metadata?.warnings ?? [];
    const warnings = coverageWarning ? [...parserWarnings, coverageWarning] : parserWarnings;

    const updated = await executeTransaction(async (tx) => {
      await insertChunks(tx, documentId, chunks, embeddings, provenance);
      return await tx.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
          metadata: {
            // Strip the leading dot so the value matches what parsePdf wrote
            // ("pdf", not ".pdf") and what the search/filter UIs expect.
            format: extname(document.fileName).toLowerCase().replace(/^\./, ''),
            rawContent: content,
            parsedTitle: metadata?.parsedTitle ?? null,
            parsedAuthor: metadata?.parsedAuthor ?? null,
            sectionCount: metadata?.sectionCount ?? null,
            warnings,
            // Carry forward the per-page diagnostic the parser stored at
            // preview time, so any future page-picker UI keeps its data
            // after the admin confirms.
            pages: metadata?.pages ?? null,
            corrected: !!correctedContent,
            coverage,
          },
        },
      });
    });

    logger.info('Document preview confirmed and processed', {
      documentId,
      chunkCount: chunks.length,
      coveragePct: coverage.coveragePct,
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

  // Prefer stored original content; fall back to lossy chunk reconstruction
  const meta = parseDocumentMetadata(document.metadata);
  const content = meta?.rawContent?.trim()
    ? meta.rawContent
    : document.chunks.map((c) => c.content).join('\n\n---\n\n');

  // Set status to processing
  await prisma.aiKnowledgeDocument.update({
    where: { id: documentId },
    data: { status: 'processing' },
  });

  try {
    // CSV rechunk has to use the row-aware chunker — chunkMarkdownDocument
    // would mash every row into the same heading-less chunk. The per-row
    // sections persisted at upload (`metadata.csvSections`) are the only
    // lossless source: rebuilding from the joined `rawContent` would shred
    // any quoted cell that contained an embedded newline.
    const isCsv = meta?.format === 'csv';
    if (isCsv && (!meta?.csvSections || meta.csvSections.length === 0)) {
      throw new Error(
        'CSV document is missing csvSections metadata — re-upload the original CSV ' +
          'to enable re-chunking. (Older CSV uploads stored only the joined content, ' +
          'which cannot be safely re-split when cells contain embedded newlines.)'
      );
    }
    const chunks = isCsv
      ? chunkCsvDocument(
          rebuildCsvParsedFromSections(meta.csvSections!, document.name),
          document.name,
          documentId
        )
      : await chunkMarkdownDocument(content, document.name, documentId);

    if (chunks.length === 0) {
      await prisma.aiKnowledgeChunk.deleteMany({ where: { documentId } });
      return await prisma.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: 0 },
      });
    }

    // Re-embed (external API call — kept outside transaction)
    const texts = chunks.map((c) => c.content);
    const { embeddings, provenance } = await embedBatch(texts);

    // Coverage is recomputed against the same source the chunker ran on:
    // for CSVs that's the joined row contents (matches the upload path);
    // for everything else that's the resolved `content`.
    const coverageSource = isCsv
      ? (meta?.csvSections ?? []).map((s) => s.content).join('\n')
      : content;
    const coverage = computeCoverage(coverageSource, texts);
    const coverageWarning = buildCoverageWarning(coverage);
    const existingWarnings = (meta?.warnings ?? []).filter(
      (w) => !w.startsWith('Only ') || !w.includes('% of the parsed text was captured')
    );
    const warnings = coverageWarning ? [...existingWarnings, coverageWarning] : existingWarnings;

    // Spread existing metadata so re-chunk doesn't clobber rawContent,
    // csvSections, pages, format, etc. — only the fields we're updating
    // (warnings, coverage) need to change.
    const nextMetadata = { ...(meta ?? {}), warnings, coverage };

    // Delete old chunks + insert new ones atomically
    const updated = await executeTransaction(async (tx) => {
      await tx.aiKnowledgeChunk.deleteMany({ where: { documentId } });
      await insertChunks(tx, documentId, chunks, embeddings, provenance);
      return await tx.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: chunks.length, metadata: nextMetadata },
      });
    });

    logger.info('Document re-chunked successfully', {
      documentId,
      chunkCount: chunks.length,
      coveragePct: coverage.coveragePct,
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
