/**
 * Unit Test: Keyword Enricher
 *
 * @see lib/orchestration/knowledge/keyword-enricher.ts
 *
 * Covers:
 *   - normaliseKeywords() — strips fences, labels, quotes; collapses newlines; dedupes
 *   - enrichDocumentKeywords() — calls the LLM per chunk, writes keywords, logs cost,
 *     tolerates per-chunk failures, batches when chunk count exceeds the threshold
 *   - Empty-content chunks are skipped (not failed)
 *   - NoChunksToEnrichError when the document has no chunks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiKnowledgeChunk: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(),
  NoDefaultModelConfiguredError: class NoDefaultModelConfiguredError extends Error {},
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(),
  logCost: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';

import {
  enrichDocumentKeywords,
  normaliseKeywords,
  NoChunksToEnrichError,
} from '@/lib/orchestration/knowledge/keyword-enricher';

const MODEL_ID = 'gpt-4o-mini';
const PROVIDER_NAME = 'openai';

function makeChunk(id: string, content: string) {
  return { id, content };
}

function makeChatResponse(text: string, inputTokens = 80, outputTokens = 20) {
  return {
    content: text,
    usage: { inputTokens, outputTokens },
    model: MODEL_ID,
    finishReason: 'stop' as const,
  };
}

function setupProvider(chatImpl: (...args: never[]) => Promise<unknown>) {
  vi.mocked(getDefaultModelForTask).mockResolvedValue(MODEL_ID);
  vi.mocked(getModel).mockReturnValue({
    id: MODEL_ID,
    provider: PROVIDER_NAME,
    tier: 'budget',
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
  } as never);
  vi.mocked(getProvider).mockResolvedValue({
    name: PROVIDER_NAME,
    isLocal: false,
    chat: vi.fn().mockImplementation(chatImpl),
  } as never);
  vi.mocked(calculateCost).mockReturnValue({
    inputCostUsd: 0.00001,
    outputCostUsd: 0.00001,
    totalCostUsd: 0.00002,
    isLocal: false,
  });
  vi.mocked(logCost).mockResolvedValue(null);
}

describe('normaliseKeywords', () => {
  it('returns empty string for empty input', () => {
    expect(normaliseKeywords('')).toBe('');
    expect(normaliseKeywords('   ')).toBe('');
  });

  it('lowercases and trims comma-separated tokens', () => {
    expect(normaliseKeywords('Vector Search, BM25, Hybrid Retrieval')).toBe(
      'vector search, bm25, hybrid retrieval'
    );
  });

  it('strips a leading "Keywords:" label', () => {
    expect(normaliseKeywords('Keywords: alpha, beta, gamma')).toBe('alpha, beta, gamma');
  });

  it('strips markdown code fences', () => {
    expect(normaliseKeywords('```\nalpha, beta\n```')).toBe('alpha, beta');
    expect(normaliseKeywords('```text\nalpha, beta\n```')).toBe('alpha, beta');
  });

  it('strips surrounding quotes/backticks from each token', () => {
    expect(normaliseKeywords('"alpha", `beta`, \'gamma\'')).toBe('alpha, beta, gamma');
  });

  it('collapses newlines into the comma list', () => {
    expect(normaliseKeywords('alpha\nbeta\ngamma')).toBe('alpha, beta, gamma');
  });

  it('drops trailing terminal punctuation', () => {
    expect(normaliseKeywords('alpha., beta!, gamma?')).toBe('alpha, beta, gamma');
  });

  it('dedupes while preserving order', () => {
    expect(normaliseKeywords('alpha, beta, alpha, gamma, beta')).toBe('alpha, beta, gamma');
  });

  it('drops absurdly long tokens (probable model drift)', () => {
    const long = 'x'.repeat(120);
    expect(normaliseKeywords(`alpha, ${long}, beta`)).toBe('alpha, beta');
  });
});

describe('enrichDocumentKeywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NoChunksToEnrichError when the document has no chunks', async () => {
    setupProvider(async () => makeChatResponse('alpha, beta'));
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([]);

    await expect(enrichDocumentKeywords('doc-1')).rejects.toBeInstanceOf(NoChunksToEnrichError);
  });

  it('calls the LLM once per chunk and writes normalised keywords', async () => {
    const chatMock = vi.fn().mockResolvedValue(makeChatResponse('Vector Search, BM25, Hybrid'));
    setupProvider(chatMock as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk('c1', 'How hybrid search combines BM25 and vector retrieval.'),
      makeChunk('c2', 'Reciprocal rank fusion for merging result lists.'),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    const result = await enrichDocumentKeywords('doc-1');

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prisma.aiKnowledgeChunk.update)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prisma.aiKnowledgeChunk.update).mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'c1' },
      data: { keywords: 'vector search, bm25, hybrid' },
    });
    expect(result.chunksProcessed).toBe(2);
    expect(result.chunksFailed).toBe(0);
    expect(result.chunksSkipped).toBe(0);
    expect(result.model).toBe(MODEL_ID);
  });

  it('writes null when the model returns empty keywords (e.g. boilerplate chunk)', async () => {
    const chatMock = vi.fn().mockResolvedValue(makeChatResponse(''));
    setupProvider(chatMock as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk('c1', 'Copyright 2025.'),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    await enrichDocumentKeywords('doc-1');

    expect(vi.mocked(prisma.aiKnowledgeChunk.update).mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'c1' },
      data: { keywords: null },
    });
  });

  it('skips (does not call LLM for) chunks with empty content', async () => {
    const chatMock = vi.fn().mockResolvedValue(makeChatResponse('alpha, beta'));
    setupProvider(chatMock as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk('c1', '   '),
      makeChunk('c2', 'real content here'),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    const result = await enrichDocumentKeywords('doc-1');

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.chunksSkipped).toBe(1);
    expect(result.chunksProcessed).toBe(1);
  });

  it('counts a per-chunk failure but continues the rest of the doc', async () => {
    const chatMock = vi
      .fn()
      .mockResolvedValueOnce(makeChatResponse('alpha, beta'))
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(makeChatResponse('gamma, delta'));
    setupProvider(chatMock as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk('c1', 'one'),
      makeChunk('c2', 'two'),
      makeChunk('c3', 'three'),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    const result = await enrichDocumentKeywords('doc-1');

    expect(result.chunksProcessed).toBe(2);
    expect(result.chunksFailed).toBe(1);
    expect(result.chunksSkipped).toBe(0);
    expect(vi.mocked(prisma.aiKnowledgeChunk.update)).toHaveBeenCalledTimes(2);
  });

  it('logs cost once per processed chunk under the knowledge.enrich_keywords operation', async () => {
    const chatMock = vi.fn().mockResolvedValue(makeChatResponse('alpha, beta'));
    setupProvider(chatMock as never);
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue([
      makeChunk('c1', 'one'),
      makeChunk('c2', 'two'),
    ] as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    await enrichDocumentKeywords('doc-1');

    // Logged fire-and-forget — settle microtasks before assertion.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(logCost)).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(logCost).mock.calls[0]?.[0];
    expect(firstCall?.operation).toBe('knowledge.enrich_keywords');
    expect(firstCall?.metadata).toMatchObject({
      documentId: 'doc-1',
    });
  });

  it('processes large docs in parallel batches above the threshold', async () => {
    // BATCH_THRESHOLD = 8, BATCH_SIZE = 5. With 10 chunks we expect two batches.
    const callOrder: string[] = [];
    const chatMock = vi.fn().mockImplementation(async (...args: unknown[]) => {
      // The user prompt is the second message; extract chunk id from its text.
      const messages = args[0] as Array<{ role: string; content: string }>;
      const userContent = messages[1]?.content ?? '';
      callOrder.push(userContent.slice(0, 30));
      return makeChatResponse('alpha, beta');
    });
    setupProvider(chatMock as never);
    const chunks = Array.from({ length: 10 }, (_, i) => makeChunk(`c${i}`, `content ${i}`));
    vi.mocked(prisma.aiKnowledgeChunk.findMany).mockResolvedValue(chunks as never);
    vi.mocked(prisma.aiKnowledgeChunk.update).mockResolvedValue({} as never);

    const result = await enrichDocumentKeywords('doc-1');

    expect(result.chunksProcessed).toBe(10);
    expect(chatMock).toHaveBeenCalledTimes(10);
  });
});
