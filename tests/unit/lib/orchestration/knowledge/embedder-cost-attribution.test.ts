/**
 * Embedder cost attribution (#654 part 3)
 *
 * Every embedding call writes an `AiCostLog` row. Until this change those rows
 * landed with `agentId`, `conversationId` and `workflowExecutionId` all null and
 * no metadata: real spend, counted in the global total, belonging to nothing.
 * A query embedding made on an agent's behalf and a bulk document import were
 * indistinguishable once written.
 *
 * The three id columns are **foreign keys**, so the only two safe values at any
 * call site are a real row id or nothing at all. `logCost` swallows the P2003 a
 * placeholder raises and returns `null` — which is exactly how the same mistake
 * went unnoticed three times (#599, #600, #654). These tests pin both halves:
 * what is passed arrives, and what is not passed is *absent* rather than null.
 *
 * @see lib/orchestration/knowledge/embedder.ts
 * @see tests/unit/lib/orchestration/llm/cost-log-fk-attribution.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findMany: vi.fn(), findFirst: vi.fn() },
    aiOrchestrationSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    aiProviderModel: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async (task: string) =>
    task === 'embeddings' ? 'text-embedding-3-small' : 'fixture-chat-model'
  ),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
  calculateEmbeddingCost: vi.fn(() => ({
    inputCostUsd: 0.0001,
    outputCostUsd: 0,
    totalCostUsd: 0.0001,
    isLocal: false,
  })),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { prisma } = await import('@/lib/db/client');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { embedText, embedBatch } = await import('@/lib/orchestration/knowledge/embedder');

const mockLogCost = vi.mocked(logCost);

/** One OpenAI-shaped embedding response per input. */
function embeddingResponse(count: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: Array.from({ length: count }, (_, index) => ({ embedding: [0.1, 0.2], index })),
      usage: { prompt_tokens: 12 },
    }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
    {
      id: 'p1',
      slug: 'openai',
      providerType: 'openai-compatible',
      isActive: true,
      isDefault: true,
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      config: { embeddingModel: 'text-embedding-3-small', embeddingDimensions: 2 },
    },
  ] as never);
  process.env.OPENAI_API_KEY = 'sk-test';
  mockFetch.mockResolvedValue(embeddingResponse(1));
});

/** The single `logCost` params object, or a clear failure if there wasn't one. */
function costParams(): Record<string, unknown> {
  expect(mockLogCost).toHaveBeenCalledTimes(1);
  return mockLogCost.mock.calls[0][0] as unknown as Record<string, unknown>;
}

describe('embedText cost attribution', () => {
  it('writes the attribution it is given onto the cost row', async () => {
    await embedText('a query', 'query', {
      agentId: 'agent-real',
      conversationId: 'conv-real',
      workflowExecutionId: 'exec-real',
      metadata: { kind: 'knowledge_search', stepId: 'step-7' },
    });

    expect(costParams()).toMatchObject({
      agentId: 'agent-real',
      conversationId: 'conv-real',
      workflowExecutionId: 'exec-real',
      metadata: { kind: 'knowledge_search', stepId: 'step-7' },
      operation: 'embedding',
    });
  });

  it('omits the foreign-key columns entirely when nothing is passed', async () => {
    // Absent, not null-or-placeholder. This is the state every embedding row
    // was in before #654 — the row persisted, so nothing looked wrong.
    await embedText('a query', 'query');

    const params = costParams();
    expect(params).not.toHaveProperty('agentId');
    expect(params).not.toHaveProperty('conversationId');
    expect(params).not.toHaveProperty('workflowExecutionId');
    expect(params).not.toHaveProperty('metadata');
    // The row is still written — this is attribution, not gating.
    expect(params).toMatchObject({ operation: 'embedding', inputTokens: 12 });
  });

  it('omits a column whose value is an empty string rather than writing it', async () => {
    // An empty string is not a row id, and `''` is what a carrier threaded
    // through several layers degrades to when one of them has nothing to say.
    await embedText('a query', 'query', { agentId: '', conversationId: 'conv-real' });

    const params = costParams();
    expect(params).not.toHaveProperty('agentId');
    expect(params).toMatchObject({ conversationId: 'conv-real' });
  });

  it('still returns the embedding when no attribution is supplied', async () => {
    // Guards against the fix turning attribution into a requirement: the
    // embedding vector is the contract, accounting is best-effort.
    const result = await embedText('a query');
    expect(result.embedding).toEqual([0.1, 0.2]);
  });
});

describe('embedBatch cost attribution', () => {
  it('writes the attribution onto the batch roll-up row', async () => {
    mockFetch.mockResolvedValue(embeddingResponse(2));

    await embedBatch(['one', 'two'], undefined, 'document', {
      metadata: { kind: 'knowledge_ingest', documentId: 'doc-1' },
    });

    expect(costParams()).toMatchObject({
      metadata: { kind: 'knowledge_ingest', documentId: 'doc-1' },
      operation: 'embedding',
    });
  });

  it('omits the foreign-key columns on an ingestion batch', async () => {
    // Deliberate: there is no agent or conversation behind a document upload.
    // The metadata is what makes the row attributable at all.
    mockFetch.mockResolvedValue(embeddingResponse(2));

    await embedBatch(['one', 'two'], undefined, 'document', {
      metadata: { kind: 'knowledge_ingest', documentId: 'doc-1' },
    });

    const params = costParams();
    expect(params).not.toHaveProperty('agentId');
    expect(params).not.toHaveProperty('conversationId');
  });
});
