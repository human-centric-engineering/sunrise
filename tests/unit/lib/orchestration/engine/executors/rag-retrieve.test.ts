/**
 * Tests for `lib/orchestration/engine/executors/rag-retrieve.ts`.
 *
 * Covers:
 *   - Happy path: query interpolated, searchKnowledge called, chunks mapped.
 *   - Missing query → ExecutorError('missing_query').
 *   - searchKnowledge throws → ExecutorError('search_failed').
 *   - Empty results → output has chunks: [], count: 0.
 *   - Custom topK and similarityThreshold forwarded to searchKnowledge.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  interpolatePrompt: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeRagRetrieve } from '@/lib/orchestration/engine/executors/rag-retrieve';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { query: 'hello' },
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as any,
    ...overrides,
  };
}

function makeStep(configOverrides?: Record<string, unknown>): WorkflowStep {
  return {
    id: 'rag1',
    name: 'Test RAG Retrieve',
    type: 'rag_retrieve',
    config: {
      query: '{{input.query}}',
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeRagRetrieve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: interpolates query, calls searchKnowledge, maps chunks', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('hello');
    vi.mocked(searchKnowledge).mockResolvedValue([
      {
        chunk: {
          id: 'chunk1',
          chunkKey: 'doc1_chunk1',
          content: 'doc1',
          documentId: 'd1',
          chunkType: 'text',
          patternNumber: null,
          patternName: null,
          section: null,
          keywords: null,
          estimatedTokens: null,
          embeddingModel: null,
          embeddingProvider: null,
          embeddingDimension: null,
          embeddedAt: null,
          metadata: null,
        },
        similarity: 0.9,
      },
    ]);

    const result = await executeRagRetrieve(makeStep(), makeCtx());

    expect(result.output).toEqual({
      chunks: [
        {
          content: 'doc1',
          similarity: 0.9,
          documentId: 'd1',
          chunkType: 'text',
        },
      ],
      count: 1,
      query: 'hello',
    });
    expect(result.tokensUsed).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('throws ExecutorError with code "missing_query" when query is absent', async () => {
    const step = makeStep({ query: undefined });

    await expect(executeRagRetrieve(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_query',
      stepId: 'rag1',
    });
    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it('throws ExecutorError with code "missing_query" when query is empty string', async () => {
    const step = makeStep({ query: '' });

    await expect(executeRagRetrieve(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_query',
    });
  });

  it('throws ExecutorError with code "search_failed" when searchKnowledge throws', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('hello');
    vi.mocked(searchKnowledge).mockRejectedValue(new Error('pgvector error'));

    await expect(executeRagRetrieve(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'search_failed',
      stepId: 'rag1',
    });
  });

  it('returns empty chunks array when searchKnowledge returns no results', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('no match');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const result = await executeRagRetrieve(makeStep(), makeCtx());

    expect(result.output).toEqual({
      chunks: [],
      count: 0,
      query: 'no match',
    });
  });

  it('forwards custom topK and similarityThreshold to searchKnowledge', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('q');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const step = makeStep({ query: 'q', topK: 3, similarityThreshold: 0.5 });
    await executeRagRetrieve(step, makeCtx());

    expect(searchKnowledge).toHaveBeenCalledWith('q', undefined, 3, 0.5, expect.any(Object));
  });

  it('uses defaults topK=5 and similarityThreshold=0.7 when not specified', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('q');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    await executeRagRetrieve(makeStep(), makeCtx());

    expect(searchKnowledge).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      5,
      0.7,
      expect.any(Object)
    );
  });

  it('passes filters from config to searchKnowledge', async () => {
    vi.mocked(interpolatePrompt).mockReturnValue('q');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const filters = { chunkType: 'text', documentId: 'doc1' };
    const step = makeStep({ query: 'q', filters });
    await executeRagRetrieve(step, makeCtx());

    expect(searchKnowledge).toHaveBeenCalledWith('q', filters, 5, 0.7, expect.any(Object));
  });

  // ── Cost attribution (#654) ─────────────────────────────────────────────

  it('attributes the query embedding to the execution and the step', async () => {
    // The embedding is real spend the workflow caused. Before #654 the row
    // landed with no execution, no step and no metadata, so it counted toward
    // the global total and appeared against nothing an operator could open.
    //
    // `stepId` in particular is load-bearing: both execution cost readers do
    // `const stepId = extractStepId(row.metadata); if (!stepId) continue;`, so a
    // row without it is dropped by the two panels that would show it.
    vi.mocked(interpolatePrompt).mockReturnValue('q');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const step = makeStep({ query: 'q' });
    await executeRagRetrieve(step, makeCtx());

    const attribution = vi.mocked(searchKnowledge).mock.calls[0][4];
    expect(attribution).toMatchObject({
      workflowExecutionId: 'exec_1',
      metadata: expect.objectContaining({ stepId: step.id, kind: 'rag_retrieve' }),
    });
    // No `agentId`: a workflow step has no `AiAgent.id`, and the synthetic
    // label it does have is not one — writing it would violate the FK.
    expect(attribution).not.toHaveProperty('agentId');
  });

  it("carries the executor chain's cost metadata through, without letting it overwrite stepId", async () => {
    // Same precedence rule as every other cost sink in the engine (#600):
    // caller keys first, the executor's own facts last. A caller able to set
    // `stepId` could attribute this embedding to a different step.
    vi.mocked(interpolatePrompt).mockReturnValue('q');
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const step = makeStep({ query: 'q' });
    await executeRagRetrieve(
      step,
      makeCtx({ costLogMetadata: { evaluationRunId: 'run-9', stepId: 'somebody-elses-step' } })
    );

    const attribution = vi.mocked(searchKnowledge).mock.calls[0][4] as {
      metadata: Record<string, unknown>;
    };
    expect(attribution.metadata.evaluationRunId).toBe('run-9');
    expect(attribution.metadata.stepId).toBe(step.id);
  });
});
