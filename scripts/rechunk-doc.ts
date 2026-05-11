/**
 * One-shot: re-chunk a specific document by id.
 *
 * Usage: tsx scripts/rechunk-doc.ts <documentId>
 *
 * Re-runs the chunker + embedder pipeline on an existing document.
 * Used to backfill documents that were chunked before a chunker fix
 * landed — e.g. the form-feed-vs-blank-line page-joiner change that
 * made the chunker's paragraph splitter no-op on PDF text. Keeps the
 * AiKnowledgeDocument row and its metadata; replaces every chunk.
 */

import { rechunkDocument } from '@/lib/orchestration/knowledge/document-manager';
import { logger } from '@/lib/logging';

async function main(): Promise<void> {
  const documentId = process.argv[2];
  if (!documentId) {
    logger.error('Missing documentId', { usage: 'tsx scripts/rechunk-doc.ts <documentId>' });
    process.exit(1);
  }
  const result = await rechunkDocument(documentId);
  logger.info('Rechunk complete', {
    documentId: result.id,
    name: result.name,
    status: result.status,
  });
}

void main().catch((err: unknown) => {
  logger.error('Rechunk failed', err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
