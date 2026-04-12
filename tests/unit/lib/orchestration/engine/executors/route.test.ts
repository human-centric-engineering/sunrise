/**
 * Tests for `lib/orchestration/engine/executors/route.ts`.
 *
 * Covers:
 *   - Happy path: LLM returns a valid label, edge resolved, nextStepIds set.
 *   - Missing routes → ExecutorError('missing_routes').
 *   - Missing classificationPrompt → ExecutorError('missing_classification_prompt').
 *   - Unknown label from LLM → ExecutorError('unknown_branch').
 *   - Case-insensitive label matching.
 *   - Prefix match (LLM returns label + extra text).
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

import { executeRoute } from '@/lib/orchestration/engine/executors/route';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { message: 'I need help' },
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

function makeRouteStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'route1',
    name: 'Test Router',
    type: 'route',
    config: {
      classificationPrompt: 'classify',
      routes: [{ label: 'support' }, { label: 'sales' }],
      ...overrides,
    },
    nextSteps: [
      { targetStepId: 'b', condition: 'support' },
      { targetStepId: 'c', condition: 'sales' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns nextStepIds and branch output for exact label match', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'support',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeRoute(makeRouteStep(), makeCtx());

    expect(result).toMatchObject({
      output: { branch: 'support', raw: 'support' },
      nextStepIds: ['b'],
      tokensUsed: 5,
      costUsd: 0.005,
    });
  });

  it('throws ExecutorError with code "missing_routes" when routes array is empty', async () => {
    const step = makeRouteStep({ routes: [] });

    await expect(executeRoute(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_routes',
    });
  });

  it('throws ExecutorError with code "missing_routes" when routes is absent', async () => {
    const step = makeRouteStep({ routes: undefined });

    await expect(executeRoute(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_routes',
    });
  });

  it('throws ExecutorError with code "missing_classification_prompt" when prompt is absent', async () => {
    const step = makeRouteStep({ classificationPrompt: undefined });

    await expect(executeRoute(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_classification_prompt',
    });
  });

  it('throws ExecutorError with code "missing_classification_prompt" when prompt is empty', async () => {
    const step = makeRouteStep({ classificationPrompt: '   ' });

    await expect(executeRoute(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_classification_prompt',
    });
  });

  it('throws ExecutorError with code "unknown_branch" when LLM returns unrecognized label', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'billing',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    await expect(executeRoute(makeRouteStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'unknown_branch',
    });
  });

  it('performs case-insensitive label matching', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'SUPPORT',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeRoute(makeRouteStep(), makeCtx());

    expect(result).toMatchObject({
      output: { branch: 'support' },
      nextStepIds: ['b'],
    });
  });

  it('matches by prefix when LLM appends extra explanation', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'support - this is clearly a support case',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeRoute(makeRouteStep(), makeCtx());

    expect(result).toMatchObject({
      output: { branch: 'support' },
      nextStepIds: ['b'],
    });
  });

  it('selects the correct branch for the second label', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'sales',
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const result = await executeRoute(makeRouteStep(), makeCtx());

    expect(result).toMatchObject({
      output: { branch: 'sales' },
      nextStepIds: ['c'],
    });
  });
});
