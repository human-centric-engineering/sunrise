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
 * A row written before `position` existed has none, and its document's
 * section order is not stored anywhere: see {@link sortByKeySections} for the
 * best order those rows give. Re-chunking writes every row's position, in true
 * order when the document still holds its raw content; without it that best
 * order is all there is, and that is what gets stored.
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

  const ordered = byPosition(chunks) ?? sortByKeySections(chunks);

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

/**
 * The best order rows without `position` give: each section's chunks together,
 * in numeric `-N` order, with the sections in `chunkKey` order.
 *
 * A key is `<document>-<section>` for a section that fit one chunk and
 * `<document>-<section>-<N>` for one split into several, plus a `~N` dedupe
 * suffix on a repeated heading (#1215). The section is the key without its
 * `-N`, so `-10` follows `-2` within it (a plain `chunkKey` sort puts it first)
 * and sections are not mixed together (sorting on `N` alone gives every
 * section's `-0` before any `-1`, since `N` restarts in each).
 *
 * The order of the sections themselves is not recoverable from the keys. They
 * come in `chunkKey` order, by section slug, as rows were always read before
 * t-1106. A slug ending in digits (`april-1-2026`) reads as a section with an
 * index, which only moves it among sections already in slug order.
 */
export function sortByKeySections<T extends { chunkKey: string }>(chunks: T[]): T[] {
  const keyed = chunks.map((chunk) => {
    const match = /^(.*)-(\d+)(~\d+)?$/.exec(chunk.chunkKey);
    return match
      ? { section: match[1] + (match[3] ?? ''), index: Number.parseInt(match[2], 10), chunk }
      : { section: chunk.chunkKey, index: -1, chunk };
  });
  keyed.sort(
    (a, b) =>
      a.section.localeCompare(b.section) ||
      a.index - b.index ||
      a.chunk.chunkKey.localeCompare(b.chunk.chunkKey)
  );
  return keyed.map((entry) => entry.chunk);
}
