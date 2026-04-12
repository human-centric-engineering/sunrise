/**
 * Tests for `lib/orchestration/engine/executors/llm-call.ts`.
 *
 * Covers:
 *   - Happy path: valid prompt → output with content/tokensUsed/costUsd.
 *   - Missing prompt (undefined): throws ExecutorError('missing_prompt').
 *   - Empty string prompt: throws ExecutorError('missing_prompt').
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

import { executeLlmCall } from '@/lib/orchestration/engine/executors/llm-call';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
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
    id: 'step1',
    name: 'Test LLM Call',
    type: 'llm_call',
    config: { prompt: 'hello', ...configOverrides },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeLlmCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns output, tokensUsed, costUsd from runLlmCall', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'world',
      tokensUsed: 10,
      costUsd: 0.01,
      model: 'gpt-4',
    });

    const result = await executeLlmCall(makeStep(), makeCtx());

    expect(result).toEqual({
      output: 'world',
      tokensUsed: 10,
      costUsd: 0.01,
    });
  });

  it('forwards prompt and config options to runLlmCall', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'response',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'gpt-3.5',
    });

    const step = makeStep({
      prompt: 'custom prompt',
      modelOverride: 'gpt-3.5',
      temperature: 0.7,
      maxTokens: 500,
    });
    const ctx = makeCtx();
    await executeLlmCall(step, ctx);

    expect(runLlmCall).toHaveBeenCalledWith(ctx, {
      stepId: 'step1',
      prompt: 'custom prompt',
      modelOverride: 'gpt-3.5',
      temperature: 0.7,
      maxTokens: 500,
    });
  });

  it('throws ExecutorError with code "missing_prompt" when prompt is undefined', async () => {
    const step = makeStep({ prompt: undefined });

    await expect(executeLlmCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_prompt',
      stepId: 'step1',
    });
    expect(runLlmCall).not.toHaveBeenCalled();
  });

  it('throws ExecutorError with code "missing_prompt" when prompt is empty string', async () => {
    const step = makeStep({ prompt: '' });

    await expect(executeLlmCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_prompt',
      stepId: 'step1',
    });
    expect(runLlmCall).not.toHaveBeenCalled();
  });

  it('throws ExecutorError with code "missing_prompt" when prompt is whitespace only', async () => {
    const step = makeStep({ prompt: '   ' });

    await expect(executeLlmCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_prompt',
    });
  });

  it('propagates ExecutorError thrown by runLlmCall', async () => {
    vi.mocked(runLlmCall).mockRejectedValue(
      new ExecutorError('step1', 'llm_call_failed', 'Network error')
    );

    await expect(executeLlmCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'llm_call_failed',
    });
  });
});
