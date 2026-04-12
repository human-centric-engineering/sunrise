/**
 * Tests for `lib/orchestration/engine/executors/plan.ts`.
 *
 * Covers:
 *   - Happy path: LLM returns numbered list → parsed into plan array.
 *   - Missing objective → ExecutorError('missing_objective').
 *   - List capped at maxSubSteps.
 *   - Empty / non-numbered lines are filtered out.
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

import { executePlan } from '@/lib/orchestration/engine/executors/plan';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { task: 'build a website' },
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
    id: 'plan1',
    name: 'Test Plan',
    type: 'plan',
    config: {
      objective: 'Plan the project',
      maxSubSteps: 5,
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: parses numbered list from LLM response into plan array', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '1. Do A\n2. Do B\n3. Do C',
      tokensUsed: 20,
      costUsd: 0.02,
      model: 'm',
    });

    const result = await executePlan(makeStep(), makeCtx());

    expect(result.output).toMatchObject({
      plan: ['Do A', 'Do B', 'Do C'],
      rawResponse: '1. Do A\n2. Do B\n3. Do C',
    });
    expect(result.tokensUsed).toBe(20);
    expect(result.costUsd).toBe(0.02);
  });

  it('throws ExecutorError with code "missing_objective" when objective is absent', async () => {
    const step = makeStep({ objective: undefined });

    await expect(executePlan(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_objective',
    });
    expect(runLlmCall).not.toHaveBeenCalled();
  });

  it('throws ExecutorError with code "missing_objective" when objective is empty string', async () => {
    const step = makeStep({ objective: '' });

    await expect(executePlan(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_objective',
    });
  });

  it('caps the plan at maxSubSteps', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five',
      tokensUsed: 15,
      costUsd: 0.015,
      model: 'm',
    });

    const step = makeStep({ maxSubSteps: 2 });
    const result = await executePlan(step, makeCtx());

    expect((result.output as { plan: string[] }).plan).toHaveLength(2);
    expect((result.output as { plan: string[] }).plan).toEqual(['Step one', 'Step two']);
  });

  it('filters out empty and whitespace-only lines', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '\n  \n1. Real step\n',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executePlan(makeStep(), makeCtx());

    expect((result.output as { plan: string[] }).plan).toHaveLength(1);
    expect((result.output as { plan: string[] }).plan[0]).toBe('Real step');
  });

  it('defaults maxSubSteps to 5 when not specified', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '1. A\n2. B\n3. C\n4. D\n5. E\n6. F\n7. G',
      tokensUsed: 10,
      costUsd: 0.01,
      model: 'm',
    });

    const step = makeStep({ maxSubSteps: undefined });
    const result = await executePlan(step, makeCtx());

    expect((result.output as { plan: string[] }).plan).toHaveLength(5);
  });

  it('includes rawResponse in output', async () => {
    const raw = '1. Only step';
    vi.mocked(runLlmCall).mockResolvedValue({
      content: raw,
      tokensUsed: 3,
      costUsd: 0.003,
      model: 'm',
    });

    const result = await executePlan(makeStep(), makeCtx());

    expect((result.output as { rawResponse: string }).rawResponse).toBe(raw);
  });
});
