/**
 * Tests for `lib/orchestration/engine/executors/reflect.ts`.
 *
 * Covers:
 *   - Converges when LLM includes a "no further changes" marker.
 *   - Missing critiquePrompt → ExecutorError('missing_critique_prompt').
 *   - Max iterations reached when every call produces new content.
 *   - Converges on the first iteration.
 *   - Tokens and cost accumulated correctly across iterations.
 *
 * Implementation note on finalDraft:
 *   The loop updates `draft = result.content` only when the LLM does NOT
 *   respond with a convergence marker. On convergence the draft retains
 *   the content from the last non-converging call (or the seed if the
 *   first call converges). This is the value stored in `output.finalDraft`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/engine/llm-runner', () => ({
  runLlmCall: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeReflect } from '@/lib/orchestration/engine/executors/reflect';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
    stepOutputs: { prev: 'initial draft' },
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
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
    id: 'reflect1',
    name: 'Test Reflect',
    type: 'reflect',
    config: {
      critiquePrompt: 'Improve this draft',
      maxIterations: 3,
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeReflect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converges on iteration 2: finalDraft is last meaningful content before convergence', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'revised draft',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      })
      .mockResolvedValueOnce({
        content: 'No further changes needed',
        tokensUsed: 8,
        costUsd: 0.008,
        model: 'm',
      });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'converged',
      iterations: 2,
      finalDraft: 'revised draft',
    });
  });

  it('throws ExecutorError with code "missing_critique_prompt" when critiquePrompt is absent', async () => {
    const step = makeStep({ critiquePrompt: undefined });

    await expect(executeReflect(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_critique_prompt',
    });
  });

  it('throws ExecutorError with code "missing_critique_prompt" when critiquePrompt is empty', async () => {
    const step = makeStep({ critiquePrompt: '   ' });

    await expect(executeReflect(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_critique_prompt',
    });
  });

  it('reaches max iterations when every call produces new content', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'new content each time',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeStep({ maxIterations: 2 });
    const result = await executeReflect(step, makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'max_iterations',
      iterations: 2,
    });
    expect(runLlmCall).toHaveBeenCalledTimes(2);
  });

  it('converges on the first iteration when the initial draft already meets criteria', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'looks good as is',
      tokensUsed: 4,
      costUsd: 0.004,
      model: 'm',
    });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      stopReason: 'converged',
      iterations: 1,
      // Converged immediately: draft was never updated, so finalDraft is the seed
      finalDraft: 'initial draft',
    });
    expect(runLlmCall).toHaveBeenCalledTimes(1);
  });

  it('accumulates tokens and cost across iterations', async () => {
    vi.mocked(runLlmCall)
      .mockResolvedValueOnce({
        content: 'iteration 1 content',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      })
      .mockResolvedValueOnce({
        content: 'No further changes',
        tokensUsed: 10,
        costUsd: 0.01,
        model: 'm',
      });

    const result = await executeReflect(makeStep(), makeCtx());

    expect(result.tokensUsed).toBe(20);
    expect(result.costUsd).toBeCloseTo(0.02);
  });

  it('uses last step output from stepOutputs as the initial draft seed', async () => {
    vi.mocked(runLlmCall).mockResolvedValueOnce({
      content: 'No further changes needed',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    // The seed is ctx.stepOutputs[lastKey]
    const ctx = makeCtx({ stepOutputs: { step_a: 'my seed draft' } });
    const result = await executeReflect(makeStep(), ctx);

    expect(result.output).toMatchObject({
      finalDraft: 'my seed draft',
      stopReason: 'converged',
    });
    // Verify the prompt passed to runLlmCall contains the seed draft
    expect(vi.mocked(runLlmCall).mock.calls[0][1].prompt).toContain('my seed draft');
  });

  it('defaults to maxIterations=3 when not specified', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'always new content',
      tokensUsed: 2,
      costUsd: 0.002,
      model: 'm',
    });

    const step = makeStep({ maxIterations: undefined });
    await executeReflect(step, makeCtx());

    expect(runLlmCall).toHaveBeenCalledTimes(3);
  });
});
