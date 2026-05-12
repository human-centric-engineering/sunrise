import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { handlePatternDetail } from '@/lib/orchestration/mcp/resources/pattern-detail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(
  overrides: Partial<{
    content: string;
    chunkType: string;
    section: string | null;
    patternName: string | null;
    category: string | null;
  }> = {}
) {
  return {
    content: 'Pattern content here',
    chunkType: 'overview',
    section: 'Introduction',
    patternName: 'Agent Loop',
    category: 'orchestration',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handlePatternDetail
// ---------------------------------------------------------------------------

describe('handlePatternDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error JSON for a URI with no pattern number', async () => {
    const result = await handlePatternDetail('sunrise://knowledge/patterns/', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.error).toBe('Invalid pattern number');
    expect(prisma.aiKnowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it('returns error JSON for a non-numeric pattern segment', async () => {
    const result = await handlePatternDetail('sunrise://knowledge/patterns/abc', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.error).toBe('Invalid pattern number');
  });

  it('returns mimeType application/json', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    const result = await handlePatternDetail('sunrise://knowledge/patterns/1', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(result.mimeType).toBe('application/json');
  });

  it('echoes the URI back in the result', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    const uri = 'sunrise://knowledge/patterns/3';
    const result = await handlePatternDetail(uri, null, { scopedAgentId: null, apiKeyId: 'key-1' });

    expect(result.uri).toBe(uri);
  });

  it('queries aiKnowledgeChunk with correct patternNumber', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    await handlePatternDetail('sunrise://knowledge/patterns/7', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(prisma.aiKnowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { patternNumber: 7 },
      })
    );
  });

  it('orders chunks by chunkKey ascending', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    await handlePatternDetail('sunrise://knowledge/patterns/1', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(prisma.aiKnowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { chunkKey: 'asc' },
      })
    );
  });

  it('selects only the required fields', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    await handlePatternDetail('sunrise://knowledge/patterns/1', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(prisma.aiKnowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          content: true,
          chunkType: true,
          section: true,
          patternName: true,
          category: true,
        },
      })
    );
  });

  it('returns error JSON when pattern number is not found', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    const result = await handlePatternDetail('sunrise://knowledge/patterns/99', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.error).toBe('Pattern 99 not found');
  });

  it('returns structured pattern data when chunks are found', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ content: 'Overview content', section: 'Overview', chunkType: 'overview' }),
    ] as never);

    const result = await handlePatternDetail('sunrise://knowledge/patterns/1', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.patternNumber).toBe(1);
    expect(body.patternName).toBe('Agent Loop');
    expect(body.category).toBe('orchestration');
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]).toEqual({
      section: 'Overview',
      chunkType: 'overview',
      content: 'Overview content',
    });
  });

  it('derives patternName and category from the first chunk', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ patternName: 'First Pattern', category: 'design' }),
      makeChunk({ patternName: 'Should be ignored', category: 'other', section: 'Details' }),
    ] as never);

    const result = await handlePatternDetail('sunrise://knowledge/patterns/2', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.patternName).toBe('First Pattern');
    expect(body.category).toBe('design');
  });

  it('maps all chunks to sections array', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk({ content: 'Section 1', section: 'Intro', chunkType: 'overview' }),
      makeChunk({ content: 'Section 2', section: 'Details', chunkType: 'detail' }),
      makeChunk({ content: 'Section 3', section: 'Examples', chunkType: 'example' }),
    ] as never);

    const result = await handlePatternDetail('sunrise://knowledge/patterns/5', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.sections).toHaveLength(3);
    expect(body.sections[1]).toMatchObject({ section: 'Details', chunkType: 'detail' });
  });

  it('ignores the config parameter', async () => {
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([makeChunk()] as never);

    await expect(
      handlePatternDetail(
        'sunrise://knowledge/patterns/1',
        { someConfig: true },
        { scopedAgentId: null, apiKeyId: 'key-1' }
      )
    ).resolves.not.toThrow();
  });
});
