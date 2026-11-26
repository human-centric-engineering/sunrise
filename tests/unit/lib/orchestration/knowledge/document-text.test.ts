/**
 * Unit Tests: rebuildTextFromChunks
 *
 * A finished document no longer stores its own text — originalContent and
 * processedContent are cleared on finalise — so the chunk rows are the only
 * surviving copy. Ordering is the whole risk here: document order lives in the
 * numeric suffix of chunkKey, and the lexicographic sort used elsewhere in the
 * codebase would scramble it.
 *
 * @see lib/orchestration/knowledge/document-text.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChunkFindMany } = vi.hoisted(() => ({ mockChunkFindMany: vi.fn() }));

vi.mock('@/lib/db/client', () => ({
  prisma: { aiKnowledgeChunk: { findMany: mockChunkFindMany } },
}));

import { rebuildTextFromChunks } from '@/lib/orchestration/knowledge/document-text';

describe('rebuildTextFromChunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('orders chunks by the numeric suffix, not lexicographically', async () => {
    // Lexicographic order would put -10 before -2 AND sort by the section
    // slug first — either one scrambles the document.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-zebra-section-10', content: 'eleventh' },
      { chunkKey: 'doc-apple-section-2', content: 'third' },
      { chunkKey: 'doc-middle-section-0', content: 'first' },
    ]);

    const result = await rebuildTextFromChunks('doc-1');

    expect(result.text).toBe('first\n\nthird\n\neleventh');
    expect(result.chunkCount).toBe(3);
  });

  it('reads the index through a repeated-heading ~N suffix (#1215)', async () => {
    // The chunker appends `~N` to a repeated id; the index before it still
    // decides the order, rather than the chunk sorting last as an unindexed key.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-legacy-key', content: 'no index' },
      { chunkKey: 'doc-notes-1~2', content: 'second' },
      { chunkKey: 'doc-intro-0', content: 'first' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('first\n\nsecond\n\nno index');
  });

  it('joins chunks with a blank line', async () => {
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-a-0', content: 'one' },
      { chunkKey: 'doc-b-1', content: 'two' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('one\n\ntwo');
  });

  it('sorts a key with no numeric suffix last rather than to position zero', async () => {
    // A legacy or hand-seeded key landing at index 0 would silently prepend
    // itself to the document.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-legacy-key', content: 'no index' },
      { chunkKey: 'doc-a-0', content: 'first' },
      { chunkKey: 'doc-b-1', content: 'second' },
    ]);

    const result = await rebuildTextFromChunks('doc-1');

    expect(result.text).toBe('first\n\nsecond\n\nno index');
  });

  it('breaks an index tie on the chunk key, so the order is stable', async () => {
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-b-3', content: 'bravo' },
      { chunkKey: 'doc-a-3', content: 'alpha' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('alpha\n\nbravo');
  });

  it('returns empty text and a zero count for a document with no chunks', async () => {
    mockChunkFindMany.mockResolvedValue([]);

    const result = await rebuildTextFromChunks('doc-1');

    expect(result.text).toBe('');
    expect(result.chunkCount).toBe(0);
  });

  it('scopes the query to the requested document', async () => {
    mockChunkFindMany.mockResolvedValue([]);

    await rebuildTextFromChunks('doc-42');

    expect(mockChunkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: 'doc-42' } })
    );
  });
});
