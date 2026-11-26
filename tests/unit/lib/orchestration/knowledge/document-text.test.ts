/**
 * Unit Tests: rebuildTextFromChunks
 *
 * A finished document no longer stores its own text — originalContent and
 * processedContent are cleared on finalise — so the chunk rows are the only
 * surviving copy. Ordering is the whole risk here: document order lives in
 * `position` (t-1106); rows without it fall back to the chunkKey, which the
 * lexicographic sort used elsewhere in the codebase would scramble.
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

  it('rebuilds a multi-section document in document order from position (t-1106)', async () => {
    // What the chunker writes for "# Doc / ## Alpha / ## Beta", two chunks a
    // section. The key suffix restarts per section, so sorting by it would
    // give alpha-0, beta-0, alpha-1, beta-1 with the preamble last.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-x-beta-1', content: 'beta two', position: 4 },
      { chunkKey: 'doc-x-alpha-0', content: 'alpha one', position: 1 },
      { chunkKey: 'doc-x-doc', content: 'preamble', position: 0 },
      { chunkKey: 'doc-x-beta-0', content: 'beta one', position: 3 },
      { chunkKey: 'doc-x-alpha-1', content: 'alpha two', position: 2 },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe(
      'preamble\n\nalpha one\n\nalpha two\n\nbeta one\n\nbeta two'
    );
    expect(mockChunkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ position: true }) })
    );
  });

  it('falls back to the key suffix when any row predates position', async () => {
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-a-1', content: 'second', position: 0 },
      { chunkKey: 'doc-a-0', content: 'first', position: null },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('first\n\nsecond');
  });

  it('orders a section by its numeric suffix, not lexicographically', async () => {
    // A plain chunkKey sort puts -10 before -2.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-intro-10', content: 'eleventh' },
      { chunkKey: 'doc-intro-2', content: 'third' },
      { chunkKey: 'doc-intro-0', content: 'first' },
    ]);

    const result = await rebuildTextFromChunks('doc-1');

    expect(result.text).toBe('first\n\nthird\n\neleventh');
    expect(result.chunkCount).toBe(3);
  });

  it('keeps each section together instead of mixing them on the restarting index', async () => {
    // -N restarts per section, so sorting on N alone would give a-0, b-0, a-1.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-beta-0', content: 'b0' },
      { chunkKey: 'doc-alpha-1', content: 'a1' },
      { chunkKey: 'doc-alpha-0', content: 'a0' },
      { chunkKey: 'doc-beta-1', content: 'b1' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('a0\n\na1\n\nb0\n\nb1');
  });

  it('treats a repeated heading (~N, #1215) as its own section, in index order', async () => {
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-notes-1~2', content: 'repeat two' },
      { chunkKey: 'doc-notes-1', content: 'notes two' },
      { chunkKey: 'doc-notes-0~2', content: 'repeat one' },
      { chunkKey: 'doc-notes-0', content: 'notes one' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe(
      'notes one\n\nnotes two\n\nrepeat one\n\nrepeat two'
    );
  });

  it('joins chunks with a blank line', async () => {
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-a-0', content: 'one' },
      { chunkKey: 'doc-b-1', content: 'two' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('one\n\ntwo');
  });

  it('places a single-chunk section (no suffix) among the sections by slug', async () => {
    // With no -N it is a section of its own, not an index of MAX or 0.
    mockChunkFindMany.mockResolvedValue([
      { chunkKey: 'doc-zeta-0', content: 'z0' },
      { chunkKey: 'doc-middle', content: 'only' },
      { chunkKey: 'doc-alpha-0', content: 'a0' },
    ]);

    expect((await rebuildTextFromChunks('doc-1')).text).toBe('a0\n\nonly\n\nz0');
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
