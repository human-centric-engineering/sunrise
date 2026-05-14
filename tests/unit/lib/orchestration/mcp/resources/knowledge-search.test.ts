import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  resolveAgentDocumentAccess: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { logger } from '@/lib/logging';
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
      embeddingDimension: null,
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

  describe('Scoped agent search (scopedAgentId branch)', () => {
    const AGENT_ID = 'agent-123';

    it('applies document-id filter when agent has restricted access', async () => {
      // Arrange: agent resolver returns restricted mode
      vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
        mode: 'restricted',
        documentIds: ['doc-a', 'doc-b'],
        includeSystemScope: false,
      } as never);
      vi.mocked(searchKnowledge).mockResolvedValue([makeSearchResult()]);

      // Act
      const result = await handleKnowledgeSearch(
        'sunrise://knowledge/search?q=restricted+topic',
        null,
        { scopedAgentId: AGENT_ID, apiKeyId: 'key-scoped' }
      );

      // Assert: resolver called with the agent id
      expect(vi.mocked(resolveAgentDocumentAccess)).toHaveBeenCalledWith(AGENT_ID);

      // Assert: searchKnowledge received the filter from the resolver
      expect(vi.mocked(searchKnowledge)).toHaveBeenCalledWith(
        'restricted topic',
        expect.objectContaining({
          documentIds: ['doc-a', 'doc-b'],
          includeSystemScope: false,
        }),
        10
      );

      const body = JSON.parse(result.text);
      expect(body.results).toHaveLength(1);
    });

    it('does not apply document-id filter when agent has full access', async () => {
      // Arrange: agent resolver returns full mode
      vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
        mode: 'full',
        documentIds: [],
        includeSystemScope: true,
      } as never);
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      // Act
      await handleKnowledgeSearch('sunrise://knowledge/search?q=open+topic', null, {
        scopedAgentId: AGENT_ID,
        apiKeyId: 'key-scoped',
      });

      // Assert: resolver was called
      expect(vi.mocked(resolveAgentDocumentAccess)).toHaveBeenCalledWith(AGENT_ID);

      // Assert: searchKnowledge was called with undefined filters (no restriction)
      expect(vi.mocked(searchKnowledge)).toHaveBeenCalledWith('open topic', undefined, 10);
    });

    it('does not call resolveAgentDocumentAccess when scopedAgentId is null', async () => {
      // Arrange: unscoped key — no agent id
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      // Act
      await handleKnowledgeSearch('sunrise://knowledge/search?q=global', null, {
        scopedAgentId: null,
        apiKeyId: 'key-service',
      });

      // Assert: resolver NOT called for unscoped key
      expect(vi.mocked(resolveAgentDocumentAccess)).not.toHaveBeenCalled();
    });

    it('logs a warning when an unscoped service key is used', async () => {
      // Arrange
      vi.mocked(searchKnowledge).mockResolvedValue([]);

      // Act
      await handleKnowledgeSearch('sunrise://knowledge/search?q=audit+test', null, {
        scopedAgentId: null,
        apiKeyId: 'unscoped-key-99',
      });

      // Assert: logger.info was called to surface the unscoped usage
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'MCP knowledge search via unscoped service key',
        expect.objectContaining({ apiKeyId: 'unscoped-key-99' })
      );
    });

    it('returns error envelope on malformed URI', async () => {
      // Arrange: a URI whose path component becomes an invalid host after the placeholder
      // substitution `uri.replace('sunrise://', 'https://placeholder/')`. The source
      // wraps the URL constructor in a try/catch, returning the error envelope instead
      // of throwing. We craft a URI where the replacement yields `https://[invalid]/…`
      // which Node's URL parser rejects.
      //
      // The source code does: new URL(uri.replace('sunrise://', 'https://placeholder/'))
      // so 'sunrise://[invalid]/search' → 'https://placeholder/[invalid]/search' — but
      // that actually parses fine (path, not host). Instead we need the replacement to
      // produce an invalid host. We achieve this by putting the invalid part in the
      // host segment of the URI:
      // 'sunrise://[invalid' → 'https://placeholder//[invalid' → URL parse error.
      //
      // Simplest approach: pass a completely unparseable string by exploiting that
      // the source only does .replace for the first occurrence, then passes the result
      // to `new URL(...)`. A plain string that is not a valid URL after replacement works:
      const malformedUri = 'not-a-url-at-all';

      // Act — must NOT throw
      const result = await handleKnowledgeSearch(malformedUri, null, {
        scopedAgentId: null,
        apiKeyId: 'key-1',
      });

      // Assert: graceful error response
      const body = JSON.parse(result.text) as { error?: string; results?: unknown[] };
      expect(body.error).toBeDefined();
      expect(typeof body.error).toBe('string');
      // searchKnowledge must not be called when the URI is malformed
      expect(vi.mocked(searchKnowledge)).not.toHaveBeenCalled();
    });
  });
});
