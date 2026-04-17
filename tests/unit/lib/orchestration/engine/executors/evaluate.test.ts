/**
 * Tests for `lib/orchestration/engine/executors/evaluate.ts`.
 *
 * Covers:
 *   - Happy path: numeric score parsed, reasoning extracted.
 *   - Score clamping to scale bounds.
 *   - Threshold: passed=true when score >= threshold, false below.
 *   - No threshold: passed always true.
 *   - Non-numeric score → ExecutorError('invalid_score').
 *   - Missing rubric → ExecutorError('missing_rubric').
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

import { executeEvaluate } from '@/lib/orchestration/engine/executors/evaluate';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { text: 'The answer is 42.' },
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

function makeEvaluateStep(overrides?: Partial<WorkflowStep['config']>): WorkflowStep {
  return {
    id: 'eval1',
    name: 'Test Evaluator',
    type: 'evaluate',
    config: {
      rubric: 'Rate the response on accuracy',
      scaleMin: 1,
      scaleMax: 5,
      threshold: 3,
      ...overrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeEvaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: parses score and reasoning, passes when score >= threshold', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '4\nGood accuracy and clear explanation.',
      tokensUsed: 15,
      costUsd: 0.015,
      model: 'm',
    });

    const result = await executeEvaluate(makeEvaluateStep(), makeCtx());

    expect(result).toMatchObject({
      output: {
        score: 4,
        reasoning: 'Good accuracy and clear explanation.',
        passed: true,
        threshold: 3,
      },
      tokensUsed: 15,
      costUsd: 0.015,
    });
  });

  it('fails when score is below threshold', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '2\nLacks detail.',
      tokensUsed: 10,
      costUsd: 0.01,
      model: 'm',
    });

    const result = await executeEvaluate(makeEvaluateStep(), makeCtx());

    expect(result.output).toMatchObject({
      score: 2,
      passed: false,
    });
  });

  it('clamps score to scale max', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '10\nExcellent.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeEvaluate(makeEvaluateStep(), makeCtx());
    expect(result.output).toMatchObject({ score: 5 });
  });

  it('clamps score to scale min', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '-3\nTerrible.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const result = await executeEvaluate(makeEvaluateStep(), makeCtx());
    expect(result.output).toMatchObject({ score: 1 });
  });

  it('passes when no threshold is set', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '1\nPoor quality.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeEvaluateStep({ threshold: undefined });
    const result = await executeEvaluate(step, makeCtx());

    expect(result.output).toMatchObject({ score: 1, passed: true, threshold: null });
  });

  it('throws ExecutorError with code "invalid_score" for non-numeric output', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: 'I think it deserves a high score.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    await expect(executeEvaluate(makeEvaluateStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'invalid_score',
    });
  });

  it('throws ExecutorError with code "missing_rubric" when rubric is empty', async () => {
    const step = makeEvaluateStep({ rubric: '' });

    await expect(executeEvaluate(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rubric',
    });
  });

  it('throws ExecutorError with code "missing_rubric" when rubric is absent', async () => {
    const step = makeEvaluateStep({ rubric: undefined });

    await expect(executeEvaluate(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_rubric',
    });
  });

  it('uses default scale 1-5 when not configured', async () => {
    vi.mocked(runLlmCall).mockResolvedValue({
      content: '3\nAverage.',
      tokensUsed: 5,
      costUsd: 0.005,
      model: 'm',
    });

    const step = makeEvaluateStep({
      scaleMin: undefined,
      scaleMax: undefined,
      threshold: undefined,
    });
    const result = await executeEvaluate(step, makeCtx());

    expect(result.output).toMatchObject({ score: 3, passed: true });
  });
});
