/**
 * Tests for the SearchKnowledgeCapability built-in.
 *
 * Routing model (Phase 2 of knowledge-access-control):
 *   - Capability calls `resolveAgentDocumentAccess(agentId)` exactly once per execute.
 *   - When the resolver returns `{ mode: 'full' }`, no agent-level filter is added.
 *   - When it returns `{ mode: 'restricted', documentIds, includeSystemScope }`, those
 *     fields are propagated into the SearchFilters passed to `searchKnowledge`.
 *
 * The legacy `prisma.aiAgent.findUnique` lookup was removed when the resolver landed;
 * these tests assert the new contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
  searchKnowledgeWithEmbedding: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  resolveAgentDocumentAccess: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { searchKnowledgeWithEmbedding } = await import('@/lib/orchestration/knowledge/search');

const FAKE_EMBED = {
  model: 'text-embedding-3-small',
  provider: 'openai',
  inputTokens: 10,
  costUsd: 0,
};

/**
 * Build the `{ results, embedding }` envelope the capability expects
 * from `searchKnowledgeWithEmbedding`. The legacy `searchKnowledge` mock
 * remains in the test setup because other capabilities still consume it;
 * any test that asserts on it is migrated to the new mock here.
 */
function withEmbed(results: unknown[]): { results: unknown[]; embedding: typeof FAKE_EMBED } {
  return { results, embedding: FAKE_EMBED };
}
const { resolveAgentDocumentAccess } =
  await import('@/lib/orchestration/knowledge/resolveAgentDocumentAccess');
const { SearchKnowledgeCapability } =
  await import('@/lib/orchestration/capabilities/built-in/search-knowledge');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

const context = { userId: 'u1', agentId: 'a1' };

function makeChunk(overrides: Record<string, unknown> = {}): unknown {
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
  // Default: agent has unrestricted access.
  vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({ mode: 'full' });
});

describe('SearchKnowledgeCapability', () => {
  it('calls searchKnowledge without filters when the resolver returns full access and no args are set', async () => {
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(
      withEmbed([makeChunk()])
    );
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'reason + act' }, context);

    expect(resolveAgentDocumentAccess).toHaveBeenCalledWith('a1');
    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith('reason + act', undefined, 10, 0.7);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      results: [{ chunkId: 'c1', patternNumber: 1, similarity: 0.91 }],
    });
  });

  it('passes the patternNumber filter when pattern_number is supplied', async () => {
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'plan', pattern_number: 7 }, context);

    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith(
      'plan',
      { patternNumber: 7 },
      10,
      0.7
    );
  });

  it('passes documentIds + includeSystemScope when the resolver returns restricted access', async () => {
    vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
      mode: 'restricted',
      documentIds: ['doc-1', 'doc-2'],
      includeSystemScope: true,
    });
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'refund policy' }, context);

    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith(
      'refund policy',
      { documentIds: ['doc-1', 'doc-2'], includeSystemScope: true },
      10,
      0.7
    );
  });

  it('passes the documentId filter when document_id is supplied', async () => {
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    await cap.execute(
      { query: 'clause', document_id: '550e8400-e29b-41d4-a716-446655440000' },
      context
    );

    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith(
      'clause',
      { documentId: '550e8400-e29b-41d4-a716-446655440000' },
      10,
      0.7
    );
  });

  it('combines pattern_number, document_id, and restricted document grants when the doc is granted', async () => {
    // The LLM-supplied document_id IS in the agent's grant set, so the
    // capability passes all three filters through to searchKnowledge.
    const grantedDoc = '550e8400-e29b-41d4-a716-446655440000';
    vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
      mode: 'restricted',
      documentIds: [grantedDoc, 'doc-other'],
      includeSystemScope: true,
    });
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    await cap.execute(
      {
        query: 'liability',
        pattern_number: 2,
        document_id: grantedDoc,
      },
      context
    );

    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith(
      'liability',
      {
        patternNumber: 2,
        documentId: grantedDoc,
        documentIds: [grantedDoc, 'doc-other'],
        includeSystemScope: true,
      },
      10,
      0.7
    );
  });

  it('refuses an LLM document_id that lies outside the restricted agent grant set', async () => {
    // Vuln 2 regression: under the old code the SQL would intersect the
    // singular `documentId` filter with the `documentIds` allowlist, but a
    // silently empty result set masked the boundary from operators. The
    // capability now rejects up front with a structured `forbidden_document`
    // error so the LLM can retry without the filter.
    vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({
      mode: 'restricted',
      documentIds: ['doc-granted'],
      includeSystemScope: true,
    });
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute(
      {
        query: 'confidential roadmap',
        document_id: '550e8400-e29b-41d4-a716-446655440000',
      },
      context
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'forbidden_document',
        message: expect.stringContaining('not accessible'),
      },
    });
    expect(searchKnowledgeWithEmbedding).not.toHaveBeenCalled();
  });

  it('allows document_id without restriction when the agent has full access', async () => {
    vi.mocked(resolveAgentDocumentAccess).mockResolvedValue({ mode: 'full' });
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    await cap.execute({ query: 'q', document_id: '550e8400-e29b-41d4-a716-446655440000' }, context);

    expect(searchKnowledgeWithEmbedding).toHaveBeenCalledWith(
      'q',
      { documentId: '550e8400-e29b-41d4-a716-446655440000' },
      10,
      0.7
    );
  });

  it('returns { results: [] } when the search returns nothing (not an error)', async () => {
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockResolvedValue(withEmbed([]));
    const cap = new SearchKnowledgeCapability();

    const result = await cap.execute({ query: 'obscure topic' }, context);

    // The capability also stashes a `sideEffectModel` on `metadata` so the
    // chat handler can roll embedding cost into the turn — assert only the
    // shape the consumer (the LLM-facing payload) sees.
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ results: [] });
    expect(result.metadata?.sideEffectModel).toMatchObject({ kind: 'embedding' });
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

  it('propagates searchKnowledge rejection when the vector store is unavailable', async () => {
    const storeError = new Error('vector store unavailable');
    (searchKnowledgeWithEmbedding as ReturnType<typeof vi.fn>).mockRejectedValue(storeError);
    const cap = new SearchKnowledgeCapability();

    await expect(cap.execute({ query: 'anything' }, context)).rejects.toThrow(
      'vector store unavailable'
    );
  });

  it('propagates errors from the resolver and never calls searchKnowledge', async () => {
    const resolverError = new Error('connection timeout');
    vi.mocked(resolveAgentDocumentAccess).mockRejectedValue(resolverError);
    const cap = new SearchKnowledgeCapability();

    await expect(cap.execute({ query: 'anything' }, context)).rejects.toThrow('connection timeout');
    expect(searchKnowledgeWithEmbedding).not.toHaveBeenCalled();
  });
});
