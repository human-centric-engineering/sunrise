/**
 * Unit Tests: Knowledge Search — Pattern List & Detail
 *
 * Tests listPatterns() and getPatternDetail() with mocked Prisma client.
 * Covers deduplication, section ordering, and edge cases.
 *
 * @see lib/orchestration/knowledge/search.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(() => ({ searchConfig: null })),
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: vi.fn(),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { listPatterns, getPatternDetail } from '@/lib/orchestration/knowledge/search';

// ─── Tests: listPatterns ────────────────────────────────────────────────────

describe('listPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pattern summaries from grouped chunks', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'Chain', category: 'Reasoning', _count: { id: 5 } },
      { patternNumber: 2, patternName: 'Router', category: 'Routing', _count: { id: 3 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result).toHaveLength(2);
    expect(result[0].patternNumber).toBe(1);
    expect(result[0].patternName).toBe('Chain');
    expect(result[0].chunkCount).toBe(5);
    expect(result[1].patternNumber).toBe(2);
  });

  it('deduplicates patterns with multiple categories', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'Chain', category: 'Reasoning', _count: { id: 3 } },
      { patternNumber: 1, patternName: 'Chain', category: 'Composition', _count: { id: 2 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result).toHaveLength(1);
    expect(result[0].patternNumber).toBe(1);
    expect(result[0].chunkCount).toBe(5); // 3 + 2 merged
    expect(result[0].category).toBe('Reasoning'); // keeps first
  });

  it('uses fallback name when patternName is null', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 99, patternName: null, category: null, _count: { id: 1 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result[0].patternName).toBe('Pattern 99');
  });

  it('prefers TL;DR description over overview', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'Chain', category: 'Reasoning', _count: { id: 5 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany)
      .mockResolvedValueOnce([
        { patternNumber: 1, content: '# Chain\n\nOverview paragraph.', metadata: null },
      ] as never)
      .mockResolvedValueOnce([
        { patternNumber: 1, content: '# TL;DR\n\nShort summary paragraph.' },
      ] as never);

    const result = await listPatterns();

    expect(result[0].description).toBe('Short summary paragraph.');
  });

  it('returns empty array when no patterns exist', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([]);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result).toEqual([]);
  });

  it('skips groups with null patternNumber', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: null, patternName: null, category: null, _count: { id: 2 } },
      { patternNumber: 1, patternName: 'Chain', category: 'Reasoning', _count: { id: 5 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result).toHaveLength(1);
    expect(result[0].patternNumber).toBe(1);
  });

  it('keeps first non-null category when merging duplicates', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'Chain', category: null, _count: { id: 2 } },
      { patternNumber: 1, patternName: 'Chain', category: 'Reasoning', _count: { id: 3 } },
    ] as never);

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await listPatterns();

    expect(result[0].category).toBe('Reasoning');
  });
});

// ─── Tests: getPatternDetail ────────────────────────────────────────────────

describe('getPatternDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns chunks sorted by section order', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        id: 'c1',
        chunkKey: 'p1-code',
        section: 'Code Examples',
        patternName: 'Chain',
        estimatedTokens: 100,
        content: 'code',
      },
      {
        id: 'c2',
        chunkKey: 'p1-overview',
        section: 'overview',
        patternName: 'Chain',
        estimatedTokens: 50,
        content: 'overview',
      },
      {
        id: 'c3',
        chunkKey: 'p1-when',
        section: 'When to Use',
        patternName: 'Chain',
        estimatedTokens: 80,
        content: 'when',
      },
    ] as never);

    const result = await getPatternDetail(1);

    expect(result.chunks[0].section).toBe('overview');
    expect(result.chunks[1].section).toBe('Code Examples');
    expect(result.chunks[2].section).toBe('When to Use');
  });

  it('returns total token count', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        id: 'c1',
        chunkKey: 'p1-a',
        section: 'overview',
        patternName: 'Chain',
        estimatedTokens: 100,
        content: 'a',
      },
      {
        id: 'c2',
        chunkKey: 'p1-b',
        section: 'definition',
        patternName: 'Chain',
        estimatedTokens: 200,
        content: 'b',
      },
    ] as never);

    const result = await getPatternDetail(1);

    expect(result.totalTokens).toBe(300);
  });

  it('returns empty result when no chunks exist', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await getPatternDetail(999);

    expect(result.patternName).toBeNull();
    expect(result.chunks).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('places unknown sections at the end', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        id: 'c1',
        chunkKey: 'p1-custom',
        section: 'Custom Section',
        patternName: 'Chain',
        estimatedTokens: 50,
        content: 'custom',
      },
      {
        id: 'c2',
        chunkKey: 'p1-overview',
        section: 'overview',
        patternName: 'Chain',
        estimatedTokens: 50,
        content: 'overview',
      },
    ] as never);

    const result = await getPatternDetail(1);

    expect(result.chunks[0].section).toBe('overview');
    expect(result.chunks[1].section).toBe('Custom Section');
  });

  it('handles null estimatedTokens', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      {
        id: 'c1',
        chunkKey: 'p1-a',
        section: 'overview',
        patternName: 'Chain',
        estimatedTokens: null,
        content: 'a',
      },
    ] as never);

    const result = await getPatternDetail(1);

    expect(result.totalTokens).toBe(0);
  });
});
