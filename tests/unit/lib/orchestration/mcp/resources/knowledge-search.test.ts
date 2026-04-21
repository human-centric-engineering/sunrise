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
    category: string | null;
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
      category: 'orchestration',
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
    const result = await handleKnowledgeSearch('sunrise://knowledge/search', null);

    const body = JSON.parse(result.text);
    expect(body.results).toEqual([]);
    expect(body.message).toBe('No query provided');
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('returns empty results for a whitespace-only query', async () => {
    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=   ', null);

    const body = JSON.parse(result.text);
    expect(body.results).toEqual([]);
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('calls searchKnowledge with the parsed query and limit 10', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    await handleKnowledgeSearch('sunrise://knowledge/search?q=agentic+patterns', null);

    expect(searchKnowledge).toHaveBeenCalledWith('agentic patterns', undefined, 10);
  });

  it('maps search results to simplified shape', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([makeSearchResult()]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null);

    const body = JSON.parse(result.text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({
      content: 'Chunk content about agents',
      chunkType: 'overview',
      patternNumber: 1,
      patternName: 'Pattern One',
      category: 'orchestration',
      similarity: 0.95,
    });
  });

  it('returns mimeType application/json', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null);

    expect(result.mimeType).toBe('application/json');
  });

  it('echoes the URI back in the result', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const uri = 'sunrise://knowledge/search?q=echo+test';
    const result = await handleKnowledgeSearch(uri, null);

    expect(result.uri).toBe(uri);
  });

  it('handles multiple search results', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([
      makeSearchResult({ content: 'First chunk', similarity: 0.9 }),
      makeSearchResult({ content: 'Second chunk', similarity: 0.8 }),
      makeSearchResult({ content: 'Third chunk', similarity: 0.7 }),
    ]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null);

    const body = JSON.parse(result.text);
    expect(body.results).toHaveLength(3);
    expect(body.results[0].content).toBe('First chunk');
    expect(body.results[2].content).toBe('Third chunk');
  });

  it('handles null patternNumber and patternName in results', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([
      makeSearchResult({ patternNumber: null, patternName: null, category: null }),
    ]);

    const result = await handleKnowledgeSearch('sunrise://knowledge/search?q=test', null);

    const body = JSON.parse(result.text);
    expect(body.results[0].patternNumber).toBeNull();
    expect(body.results[0].patternName).toBeNull();
    expect(body.results[0].category).toBeNull();
  });

  it('ignores the config parameter', async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    // Should not throw with any config value
    await expect(
      handleKnowledgeSearch('sunrise://knowledge/search?q=test', { maxResults: 5 })
    ).resolves.not.toThrow();
  });
});
