import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));

import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { handleKnowledgeSearch } from '@/lib/orchestration/mcp/resources/knowledge-search';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSearchResult(
  overrides: Partial<{
    content: string;
    chunkType: string;
    patternNumber: number | null;
    patternName: string | null;
    similarity: number;
  }> = {}
) {
  // Cast to `never` because the mock only supplies the fields the handler reads;
  // the full AiKnowledgeChunk has more DB-specific fields irrelevant to this test.
  return {
    chunk: {
      id: 'chunk-1',
      chunkKey: 'chunk-key-1',
      documentId: 'doc-1',
      section: null,
      keywords: null,
      estimatedTokens: null,
      embeddingModel: null,
      embeddingProvider: null,
      embeddedAt: null,
      metadata: null,
      content: 'Chunk content about agents',
      chunkType: 'overview',
      patternNumber: 1,
      patternName: 'Pattern One',
      ...overrides,
    },
    similarity: overrides.similarity ?? 0.95,
  };
}

// ---------------------------------------------------------------------------
// handleKnowledgeSearch
// ---------------------------------------------------------------------------

describe('handleKnowledgeSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty results when no query is provided', async () => {
    const result = await handleKnowledgeSearch('sunrise://knowledge/search', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.results).toEqual([]);
    expect(body.message).toBe('No query provided');
    // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies searchKnowledge skipped for empty/whitespace query
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('returns empty results for a whitespace-only query', async () => {
    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=   ', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.results).toEqual([]);
    // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies searchKnowledge skipped for empty/whitespace query
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('calls searchKnowledge with the parsed query and limit 10', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    await handleKnowledgeSearch('sunrise://knowledge/search?q=agentic+patterns', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(searchKnowledge).toHaveBeenCalledWith('agentic patterns', undefined, 10);
  });

  it('maps search results to simplified shape', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([makeSearchResult()]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({
      content: 'Chunk content about agents',
      chunkType: 'overview',
      patternNumber: 1,
      patternName: 'Pattern One',
      similarity: 0.95,
    });
  });

  it('returns mimeType application/json', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(result.mimeType).toBe('application/json');
  });

  it('echoes the URI back in the result', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const uri = 'sunrise://knowledge/search?q=echo+test';
    const result = await handleKnowledgeSearch(uri, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(result.uri).toBe(uri);
  });

  it('handles multiple search results', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([
      makeSearchResult({ content: 'First chunk', similarity: 0.9 }),
      makeSearchResult({ content: 'Second chunk', similarity: 0.8 }),
      makeSearchResult({ content: 'Third chunk', similarity: 0.7 }),
    ]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.results).toHaveLength(3);
    expect(body.results[0].content).toBe('First chunk');
    expect(body.results[2].content).toBe('Third chunk');
  });

  it('handles null patternNumber and patternName in results', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([
      makeSearchResult({ patternNumber: null, patternName: null }),
    ]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.results[0].patternNumber).toBeNull();
    expect(body.results[0].patternName).toBeNull();
  });

  it('ignores the config parameter', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    // Should not throw with any config value
    await expect(
      handleKnowledgeSearch(
        'sunrise://knowledge/search?q=test',
        { maxResults: 5 },
        { scopedAgentId: null, apiKeyId: 'key-1' }
      )
    ).resolves.not.toThrow();
  });

  it('propagates searchKnowledge rejection', async () => {
    // Arrange: searchKnowledge rejects — source has no try/catch so it propagates
    const dbError = new Error('vector search failed');
    vi.mocked(searchKnowledge).mockRejectedValue(dbError);

    // Act + Assert: handleKnowledgeSearch rejects with the same error
    await expect(
      handleKnowledgeSearch('sunrise://knowledge/search?q=agents', null, {
        scopedAgentId: null,
        apiKeyId: 'key-1',
      })
    ).rejects.toThrow('vector search failed');
  });
});
