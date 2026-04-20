/**
 * Tests for the SearchKnowledgeCapability built-in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { searchKnowledge } = await import('@/lib/orchestration/knowledge/search');
const { SearchKnowledgeCapability } =
  await import('@/lib/orchestration/capabilities/built-in/search-knowledge');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

const context = { userId: 'u1', agentId: 'a1' };

function makeChunk(overrides: Record<string, unknown> = {}) {
  return {
    chunk: {
      id: 'c1',
      chunkKey: 'pattern-1:overview',
      documentId: 'd1',
      content: 'ReAct is reason + act',
      chunkType: 'pattern',
      patternNumber: 1,
      patternName: 'ReAct',
      category: 'reasoning',
      section: 'overview',
      keywords: null,
      estimatedTokens: 42,
      metadata: null,
      ...overrides,
    },
    similarity: 0.91,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: agent with no category restrictions
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
    knowledgeCategories: [],
  } as never);
});

describe('SearchKnowledgeCapability', () => {
  it('calls searchKnowledge without filters when agent has no categories and no pattern_number', async () => {
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([makeChunk()]);
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'reason + act' }, context);

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith({
      where: { id: 'a1' },
      select: { knowledgeCategories: true },
    });
    expect(searchKnowledge).toHaveBeenCalledWith('reason + act', undefined, 10, 0.7);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      results: [{ chunkId: 'c1', patternNumber: 1, similarity: 0.91 }],
    });
  });

  it('passes the patternNumber filter when pattern_number is supplied', async () => {
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'plan', pattern_number: 7 }, context);

    expect(searchKnowledge).toHaveBeenCalledWith('plan', { patternNumber: 7 }, 10, 0.7);
  });

  it('passes agent knowledgeCategories as filter when agent has categories', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      knowledgeCategories: ['billing', 'support'],
    } as never);
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'refund policy' }, context);

    expect(searchKnowledge).toHaveBeenCalledWith(
      'refund policy',
      { categories: ['billing', 'support'] },
      10,
      0.7
    );
  });

  it('passes the documentId filter when document_id is supplied', async () => {
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    await cap.execute(
      { query: 'clause', document_id: '550e8400-e29b-41d4-a716-446655440000' },
      context
    );

    expect(searchKnowledge).toHaveBeenCalledWith(
      'clause',
      { documentId: '550e8400-e29b-41d4-a716-446655440000' },
      10,
      0.7
    );
  });

  it('combines document_id with pattern_number and categories', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      knowledgeCategories: ['legal'],
    } as never);
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    await cap.execute(
      {
        query: 'liability',
        pattern_number: 2,
        document_id: '550e8400-e29b-41d4-a716-446655440000',
      },
      context
    );

    expect(searchKnowledge).toHaveBeenCalledWith(
      'liability',
      {
        patternNumber: 2,
        documentId: '550e8400-e29b-41d4-a716-446655440000',
        categories: ['legal'],
      },
      10,
      0.7
    );
  });

  it('combines pattern_number and categories filters', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      knowledgeCategories: ['engineering'],
    } as never);
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'architecture', pattern_number: 3 }, context);

    expect(searchKnowledge).toHaveBeenCalledWith(
      'architecture',
      { patternNumber: 3, categories: ['engineering'] },
      10,
      0.7
    );
  });

  it('gracefully handles missing agent (deleted mid-session)', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([makeChunk()]);
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'anything' }, context);

    // No category filter applied — search proceeds unfiltered
    expect(searchKnowledge).toHaveBeenCalledWith('anything', undefined, 10, 0.7);
    expect(result.success).toBe(true);
  });

  it('returns { results: [] } when the search returns nothing (not an error)', async () => {
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'obscure topic' }, context);

    expect(result).toEqual({ success: true, data: { results: [] } });
  });

  it('rejects empty queries via validate()', () => {
    const cap = new SearchKnowledgeCapability();
    expect(() => cap.validate({ query: '' })).toThrow(CapabilityValidationError);
  });

  it('rejects queries longer than 500 chars via validate()', () => {
    const cap = new SearchKnowledgeCapability();
    const longQuery = 'a'.repeat(501);
    expect(() => cap.validate({ query: longQuery })).toThrow(CapabilityValidationError);
  });
});
