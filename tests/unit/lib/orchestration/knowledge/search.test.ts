/**
 * Knowledge Search Unit Tests
 *
 * Tests for hybrid vector + keyword search and pattern detail aggregation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db/client';

// --- Mocks ---

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    aiKnowledgeChunk: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Import SUT and embedder mock after mocks are registered
const { searchKnowledge, getPatternDetail, listPatterns } =
  await import('@/lib/orchestration/knowledge/search');
const { embedText } = await import('@/lib/orchestration/knowledge/embedder');

// --- Helpers ---

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-1',
    chunkKey: 'pattern-1-overview',
    documentId: 'doc-1',
    content: 'Some content',
    chunkType: 'pattern',
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'reasoning',
    section: 'overview',
    keywords: 'chain thought reasoning',
    estimatedTokens: 100,
    metadata: null,
    ...overrides,
  };
}

function makeRawRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeChunk(overrides),
    distance: 0.2,
    keyword_boost: -0.05,
    ...overrides,
  };
}

describe('searchKnowledge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(embedText).mockResolvedValue(new Array(1536).fill(0));
  });

  it('should return mapped results with correct similarity calculation', async () => {
    const row = makeRawRow({ distance: 0.2, keyword_boost: -0.05 });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([row] as never);

    const results = await searchKnowledge('what is chain of thought');

    expect(results).toHaveLength(1);
    expect(results[0].chunk.id).toBe('chunk-1');
    // similarity = 1 - distance + Math.abs(keyword_boost) = 1 - 0.2 + 0.05 = 0.85
    expect(results[0].similarity).toBeCloseTo(0.85);
  });

  it('should return empty array when no rows are returned', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    const results = await searchKnowledge('no match query');

    expect(results).toEqual([]);
  });

  it('should use default threshold 0.8 and limit 10 when not provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test query');

    const [, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [string, ...unknown[]];

    // params[0] = embeddingStr ($1), params[1] = threshold ($2), params[2] = limit ($3)
    expect(params[1]).toBe(0.8);
    expect(params[2]).toBe(10);
  });

  it('should respect custom threshold and limit when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', undefined, 5, 0.5);

    const [, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [string, ...unknown[]];

    expect(params[1]).toBe(0.5);
    expect(params[2]).toBe(5);
  });

  it('should add chunkType filter when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', { chunkType: 'pattern' });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    expect(sql).toContain('"chunkType" = $4');
    expect(params[3]).toBe('pattern');
  });

  it('should add patternNumber filter when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', { patternNumber: 7 });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    expect(sql).toContain('"patternNumber" = $4');
    expect(params[3]).toBe(7);
  });

  it('should add category filter when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', { category: 'reasoning' });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    expect(sql).toContain('category = $4');
    expect(params[3]).toBe('reasoning');
  });

  it('should add section filter when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', { section: 'overview' });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    expect(sql).toContain('section = $4');
    expect(params[3]).toBe('overview');
  });

  it('should add documentId filter when provided', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test', { documentId: 'doc-42' });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    expect(sql).toContain('"documentId" = $4');
    expect(params[3]).toBe('doc-42');
  });

  it('should place keyword param at $9 when all 5 filters are provided', async () => {
    // Param layout:
    //   $1 = embeddingStr
    //   $2 = threshold
    //   $3 = limit
    //   $4 = chunkType
    //   $5 = patternNumber
    //   $6 = category
    //   $7 = section
    //   $8 = documentId
    //   $9 = keyword query
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test query', {
      chunkType: 'pattern',
      patternNumber: 1,
      category: 'reasoning',
      section: 'overview',
      documentId: 'doc-1',
    });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    // SQL should reference $9 for the keyword placeholder
    expect(sql).toContain('$9');

    // 11 params total: embeddingStr + threshold + limit + 5 filters + keyword + 2 boost weights
    expect(params).toHaveLength(11);

    // Keyword query at position 8, followed by boost weights
    expect(params[8]).toBe('test query');
    expect(typeof params[9]).toBe('number'); // kwBoostStrong
    expect(typeof params[10]).toBe('number'); // kwBoost
  });

  it('should call embedText with the search query', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('my search query');

    expect(embedText).toHaveBeenCalledWith('my search query', 'query');
  });
});

describe('getPatternDetail', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return empty result when no chunks found', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await getPatternDetail(99);

    expect(result).toEqual({ patternName: null, chunks: [], totalTokens: 0 });
  });

  it('should return patternName from the first chunk', async () => {
    const chunks = [
      makeChunk({ section: 'overview', patternName: 'Test Pattern' }),
      makeChunk({ section: 'definition', patternName: 'Test Pattern', id: 'chunk-2' }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.patternName).toBe('Test Pattern');
  });

  it('should sum estimatedTokens null-safely', async () => {
    const chunks = [
      makeChunk({ estimatedTokens: 100 }),
      makeChunk({ estimatedTokens: null, id: 'chunk-2' }),
      makeChunk({ estimatedTokens: 200, id: 'chunk-3' }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.totalTokens).toBe(300);
  });

  it('should sort chunks by SECTION_ORDER with known sections first', async () => {
    // 'definition' is at index 3, 'overview' at index 0
    const chunks = [
      makeChunk({ section: 'definition', id: 'chunk-def' }),
      makeChunk({ section: 'overview', id: 'chunk-ov' }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.chunks[0].id).toBe('chunk-ov');
    expect(result.chunks[1].id).toBe('chunk-def');
  });

  it('should place chunks with unknown sections at position 999 (end)', async () => {
    const chunks = [
      makeChunk({ section: 'unknown-custom-section', id: 'chunk-unknown' }),
      makeChunk({ section: 'overview', id: 'chunk-ov' }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.chunks[0].id).toBe('chunk-ov');
    expect(result.chunks[1].id).toBe('chunk-unknown');
  });

  it('should handle chunks with null section (treated as unknown)', async () => {
    const chunks = [
      makeChunk({ section: null, id: 'chunk-null-section' }),
      makeChunk({ section: 'tldr', id: 'chunk-tldr' }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.chunks[0].id).toBe('chunk-tldr');
    expect(result.chunks[1].id).toBe('chunk-null-section');
  });

  it('should return all chunks in result with correct totalTokens', async () => {
    const chunks = [
      makeChunk({ section: 'overview', estimatedTokens: 50 }),
      makeChunk({ section: 'TL;DR Summary', id: 'chunk-2', estimatedTokens: 75 }),
      makeChunk({ section: 'Code Examples', id: 'chunk-3', estimatedTokens: 150 }),
    ];

    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);

    const result = await getPatternDetail(1);

    expect(result.chunks).toHaveLength(3);
    expect(result.totalTokens).toBe(275);
  });
});

describe('listPatterns', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return empty array when no pattern groups exist', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result).toEqual([]);
  });

  it('should return summaries for each pattern group', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      {
        patternNumber: 1,
        patternName: 'Chain of Thought',
        category: 'Reasoning',
        _count: { id: 5 },
      },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany)
      .mockResolvedValueOnce([
        {
          patternNumber: 1,
          content: 'A step-by-step reasoning pattern.',
          metadata: {},
        },
      ] as never) // overviews
      .mockResolvedValueOnce([] as never); // no tldrs

    const result = await listPatterns();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      patternNumber: 1,
      patternName: 'Chain of Thought',
      category: 'Reasoning',
      description: 'A step-by-step reasoning pattern.',
      chunkCount: 5,
    });
  });

  it('should skip groups where patternNumber is null', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: null, patternName: null, category: null, _count: { id: 2 } },
      { patternNumber: 1, patternName: 'CoT', category: 'Reasoning', _count: { id: 3 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result).toHaveLength(1);
    expect(result[0].patternNumber).toBe(1);
  });

  it('should fallback patternName to "Pattern N" when group name is null', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 7, patternName: null, category: null, _count: { id: 1 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result[0].patternName).toBe('Pattern 7');
  });

  it('should return null description when no overview chunk exists', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', category: 'Reasoning', _count: { id: 2 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result[0].description).toBeNull();
  });

  it('should return full first paragraph from TL;DR content (no truncation)', async () => {
    const longContent = 'A'.repeat(400);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', category: 'Reasoning', _count: { id: 1 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany)
      .mockResolvedValueOnce([{ patternNumber: 1, content: longContent, metadata: null }] as never) // overviews
      .mockResolvedValueOnce([{ patternNumber: 1, content: longContent }] as never); // tldrs

    const result = await listPatterns();

    // firstParagraph returns full content (single paragraph, no blank lines)
    expect(result[0].description).toHaveLength(400);
  });

  it('should return full first paragraph when falling back to overview', async () => {
    const longContent = 'A'.repeat(300);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', category: 'Reasoning', _count: { id: 1 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany)
      .mockResolvedValueOnce([{ patternNumber: 1, content: longContent, metadata: null }] as never) // overviews
      .mockResolvedValueOnce([] as never); // no tldrs

    const result = await listPatterns();

    // Overview fallback also returns full first paragraph
    expect(result[0].description).toHaveLength(300);
  });

  it('should batch-fetch overviews and tldrs for multiple groups', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', category: 'Reasoning', _count: { id: 3 } },
      { patternNumber: 2, patternName: 'ReAct', category: 'Action', _count: { id: 4 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany)
      .mockResolvedValueOnce([
        {
          patternNumber: 1,
          content: 'Chain of Thought desc',
          metadata: {},
        },
        {
          patternNumber: 2,
          content: 'ReAct desc',
          metadata: {},
        },
      ] as never) // overviews
      .mockResolvedValueOnce([] as never); // no tldrs

    const result = await listPatterns();

    expect(result).toHaveLength(2);
    expect(result[0].patternNumber).toBe(1);
    expect(result[1].patternNumber).toBe(2);
    // Two batched queries (overviews + tldrs) instead of N+1
    expect(prisma.aiKnowledgeChunk.findMany).toHaveBeenCalledTimes(2);
  });
});
