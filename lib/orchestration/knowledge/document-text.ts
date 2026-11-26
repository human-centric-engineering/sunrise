import { prisma } from '@/lib/db/client';

/**
 * Rebuild a document's text from its stored chunks.
 *
 * Needed because `originalContent` and `processedContent` are cleared once a
 * document is chunked and embedded — a cleanup document otherwise holds two
 * full copies of itself forever — so the chunk rows are the only surviving
 * copy of the text of a finished document.
 *
 * ORDERING. A chunk written since t-1106 carries `position`, its place in the
 * document's chunk list, and a document whose rows all carry it is rebuilt in
 * that order. The `chunkKey` suffix (`…-my-section-12`) cannot order a whole
 * document: it restarts in each section, so sorting by it puts every
 * section's first chunk before any section's second.
 *
 * A row written before `position` existed has none. Its document falls back
 * to that suffix, parsed and sorted numerically (the lexicographic sort the
 * rest of the codebase uses puts `-10` before `-2`), with the key itself as a
 * stable tie-break. That is document order for a document with one chunk per
 * section or a single section. Re-chunking writes every row's position, in
 * true order when the document still holds its raw content; without it the
 * old rows' order is all there is, and that is what gets stored.
 *
 * FIDELITY. This is the INGESTED text, not the source file: the chunker can
 * drop a fragment that fits no chunk, which is exactly what the Coverage
 * column reports. Callers should label the result as rebuilt rather than
 * presenting it as the original.
 */
export async function rebuildTextFromChunks(
  documentId: string
): Promise<{ text: string; chunkCount: number }> {
  const chunks = await prisma.aiKnowledgeChunk.findMany({
    where: { documentId },
    select: { chunkKey: true, content: true, position: true },
  });

  const ordered = byPosition(chunks) ?? sortByKeySuffix(chunks);

  return {
    text: ordered.map((c) => c.content).join('\n\n'),
    chunkCount: ordered.length,
  };
}

/**
 * A document's chunks in document order, or `null` when any row has no
 * `position` (written before t-1106) and so the true order is not stored.
 *
 * All or nothing: a document's chunks are replaced together, so a mix means
 * something wrote rows by hand, and no single order covers every row.
 */
export function byPosition<T extends { position: number | null }>(chunks: T[]): T[] | null {
  if (!chunks.every((chunk) => typeof chunk.position === 'number')) return null;
  return [...chunks].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** The pre-t-1106 order: the numeric `-N` suffix of each `chunkKey`. */
export function sortByKeySuffix<T extends { chunkKey: string }>(chunks: T[]): T[] {
  const indexed = chunks.map((chunk) => {
    // A repeated heading's chunk carries a `~N` dedupe suffix after its index
    // (chunker `dedupeChunkIds`, #1215); read the index through it.
    const match = /-(\d+)(?:~\d+)?$/.exec(chunk.chunkKey);
    // No trailing index (a hand-seeded or legacy key) sorts last rather than
    // silently landing at position 0 and corrupting the order of the rest.
    return { order: match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER, chunk };
  });
  indexed.sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.chunk.chunkKey.localeCompare(b.chunk.chunkKey)
  );
  return indexed.map((entry) => entry.chunk);
}
