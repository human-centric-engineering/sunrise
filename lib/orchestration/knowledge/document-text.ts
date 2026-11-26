import { prisma } from '@/lib/db/client';

/**
 * Rebuild a document's text from its stored chunks.
 *
 * Needed because `originalContent` and `processedContent` are cleared once a
 * document is chunked and embedded — a cleanup document otherwise holds two
 * full copies of itself forever — so the chunk rows are the only surviving
 * copy of the text of a finished document.
 *
 * ORDERING. Chunks have no index column; document order lives in the numeric
 * suffix of `chunkKey` (`…-my-section-12`). The rest of the codebase sorts by
 * `chunkKey` lexicographically, which is fine for a list but is NOT document
 * order — it sorts by the section slug first, and `-10` before `-2`. Rebuilding
 * text needs true order, so the suffix is parsed and sorted numerically, with
 * the lexicographic key as a stable tie-break for any row whose key does not
 * end in a number.
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
    select: { chunkKey: true, content: true },
  });

  const indexed = chunks.map((chunk) => {
    // A repeated heading's chunk carries a `~N` dedupe suffix after its index
    // (chunker `dedupeChunkIds`, #1215); read the index through it.
    const match = /-(\d+)(?:~\d+)?$/.exec(chunk.chunkKey);
    return {
      // No trailing index (a hand-seeded or legacy key) sorts last rather than
      // silently landing at position 0 and corrupting the order of the rest.
      order: match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER,
      chunkKey: chunk.chunkKey,
      content: chunk.content,
    };
  });
  indexed.sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.chunkKey.localeCompare(b.chunkKey)
  );

  return {
    text: indexed.map((c) => c.content).join('\n\n'),
    chunkCount: indexed.length,
  };
}
