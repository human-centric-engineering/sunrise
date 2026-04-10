/**
 * Tests for the SearchKnowledgeCapability built-in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
});

describe('SearchKnowledgeCapability', () => {
  it('calls searchKnowledge without filters when pattern_number is omitted', async () => {
    (searchKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([makeChunk()]);
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'reason + act' }, context);

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
