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

vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: vi.fn(),
}));

// Import SUT and mock modules after mocks are registered
const { searchKnowledge, getPatternDetail, listPatterns } =
  await import('@/lib/orchestration/knowledge/search');
const { embedText } = await import('@/lib/orchestration/knowledge/embedder');
const { getOrchestrationSettings } = await import('@/lib/orchestration/settings');

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

  it('should place keyword param at $8 when all 4 filters are provided', async () => {
    // Param layout:
    //   $1 = embeddingStr
    //   $2 = threshold
    //   $3 = limit
    //   $4 = chunkType
    //   $5 = patternNumber
    //   $6 = section
    //   $7 = documentId
    //   $8 = keyword query
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test query', {
      chunkType: 'pattern',
      patternNumber: 1,
      section: 'overview',
      documentId: 'doc-1',
    });

    const [sql, ...params] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0] as [
      string,
      ...unknown[],
    ];

    // SQL should reference $8 for the keyword placeholder
    expect(sql).toContain('$8');

    // 10 params total: embeddingStr + threshold + limit + 4 filters + keyword + 2 boost weights
    expect(params).toHaveLength(10);

    // Keyword query at position 7, followed by boost weights
    expect(params[7]).toBe('test query');
    expect(typeof params[8]).toBe('number'); // kwBoostStrong
    expect(typeof params[9]).toBe('number'); // kwBoost
  });

  it('should call embedText with the search query', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('my search query');

    expect(embedText).toHaveBeenCalledWith('my search query', 'query');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Hybrid mode (BM25-flavoured + vector blend)
// ────────────────────────────────────────────────────────────────────────────

describe('searchKnowledge — hybrid mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(embedText).mockResolvedValue(new Array(1536).fill(0));
  });

  /**
   * Helper to make `getOrchestrationSettings` return a stored searchConfig
   * with the hybrid flags we want for the test.
   */
  function mockHybridSettings(opts: { hybridEnabled: boolean; bm25Weight?: number }) {
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      searchConfig: {
        keywordBoostWeight: -0.02,
        vectorWeight: 1.0,
        hybridEnabled: opts.hybridEnabled,
        bm25Weight: opts.bm25Weight,
      },
    } as never);
  }

  it('uses the hybrid SQL branch when hybridEnabled is true', async () => {
    mockHybridSettings({ hybridEnabled: true, bm25Weight: 1.0 });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('section 21 notice');

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();
    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0][0];
    expect(sql).toContain('ts_rank_cd');
    expect(sql).toContain('"searchVector"');
    expect(sql).toContain('ORDER BY final_score DESC');
    // The legacy keyword_boost CASE expression must NOT appear in hybrid mode
    expect(sql).not.toContain('AS keyword_boost');
  });

  it('keeps using the legacy SQL when hybridEnabled is false (regression guard)', async () => {
    mockHybridSettings({ hybridEnabled: false });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test query');

    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0][0];
    expect(sql).toContain('AS keyword_boost');
    expect(sql).not.toContain('ts_rank_cd');
    expect(sql).not.toContain('"searchVector"');
  });

  it('keeps using the legacy SQL when no settings are stored (default behaviour preserved)', async () => {
    vi.mocked(getOrchestrationSettings).mockResolvedValue({ searchConfig: null } as never);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test query');

    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0][0];
    expect(sql).toContain('AS keyword_boost');
    expect(sql).not.toContain('ts_rank_cd');
  });

  it('passes vectorWeight and bm25Weight as floats in the param list', async () => {
    mockHybridSettings({ hybridEnabled: true, bm25Weight: 0.7 });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('section 21');

    const params = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0].slice(1);
    // Param order: $1 embedding, $2 threshold, $3 limit, $4 query, $5 vectorWeight, $6 bm25Weight
    expect(params[3]).toBe('section 21');
    expect(params[4]).toBe(1.0);
    expect(params[5]).toBe(0.7);
  });

  it('defaults bm25Weight to 1.0 when hybrid is enabled without an explicit weight', async () => {
    mockHybridSettings({ hybridEnabled: true });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('test');

    const params = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0].slice(1);
    expect(params[5]).toBe(1.0);
  });

  it('propagates vectorScore, keywordScore, and finalScore on each result', async () => {
    mockHybridSettings({ hybridEnabled: true, bm25Weight: 1.0 });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      {
        ...makeChunk(),
        documentName: 'Tenancy Handbook',
        distance: 0.2,
        vector_score: 0.8,
        keyword_score: 0.4,
        final_score: 1.2,
      },
    ] as never);

    const results = await searchKnowledge('section 21');

    expect(results).toHaveLength(1);
    expect(results[0].vectorScore).toBe(0.8);
    expect(results[0].keywordScore).toBe(0.4);
    expect(results[0].finalScore).toBe(1.2);
    // similarity is clamped to [0, 1]
    expect(results[0].similarity).toBe(1);
  });

  it('does not populate hybrid-only fields in vector-only mode (back-compat)', async () => {
    mockHybridSettings({ hybridEnabled: false });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      makeRawRow({ distance: 0.2, keyword_boost: -0.05, documentName: 'doc' }),
    ] as never);

    const results = await searchKnowledge('test');

    expect(results[0].similarity).toBeCloseTo(0.85);
    expect(results[0].vectorScore).toBeUndefined();
    expect(results[0].keywordScore).toBeUndefined();
    expect(results[0].finalScore).toBeUndefined();
  });

  it('resolves hybrid mode from a partial searchConfig (only hybridEnabled persisted)', async () => {
    // Regression: admin enables hybrid via the form without filling legacy
    // weights. The settings row persists `{ hybridEnabled: true }` only;
    // resolveSearchWeights must fall back to defaults for the missing fields.
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      searchConfig: { hybridEnabled: true },
    } as never);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);

    await searchKnowledge('section 21');

    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0][0];
    const params = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0].slice(1);
    expect(sql).toContain('ts_rank_cd');
    expect(sql).toContain('"searchVector"');
    // vectorWeight defaulted to 1.0, bm25Weight defaulted to 1.0
    expect(params[4]).toBe(1.0);
    expect(params[5]).toBe(1.0);
  });

  it('clamps similarity to [0, 1] for low/negative final scores', async () => {
    mockHybridSettings({ hybridEnabled: true, bm25Weight: 1.0 });
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      {
        ...makeChunk(),
        documentName: 'doc',
        distance: 0.95,
        vector_score: 0.05,
        keyword_score: 0,
        final_score: 0.05,
      },
    ] as never);

    const results = await searchKnowledge('weak match');

    expect(results[0].similarity).toBeCloseTo(0.05);
    expect(results[0].finalScore).toBeCloseTo(0.05);
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
      description: 'A step-by-step reasoning pattern.',
      chunkCount: 5,
    });
  });

  it('should skip groups where patternNumber is null', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: null, patternName: null, _count: { id: 2 } },
      { patternNumber: 1, patternName: 'CoT', _count: { id: 3 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result).toHaveLength(1);
    expect(result[0].patternNumber).toBe(1);
  });

  it('should fallback patternName to "Pattern N" when group name is null', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 7, patternName: null, _count: { id: 1 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result[0].patternName).toBe('Pattern 7');
  });

  it('should return null description when no overview chunk exists', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', _count: { id: 2 } },
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([] as never);

    const result = await listPatterns();

    expect(result[0].description).toBeNull();
  });

  it('should return full first paragraph from TL;DR content (no truncation)', async () => {
    const longContent = 'A'.repeat(400);
    vi.mocked(prisma.aiKnowledgeChunk.groupBy).mockResolvedValue([
      { patternNumber: 1, patternName: 'CoT', _count: { id: 1 } },
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
      { patternNumber: 1, patternName: 'CoT', _count: { id: 1 } },
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
      { patternNumber: 1, patternName: 'CoT', _count: { id: 3 } },
      { patternNumber: 2, patternName: 'ReAct', _count: { id: 4 } },
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
