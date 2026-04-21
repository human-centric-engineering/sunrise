/**
 * Tests for `lib/orchestration/engine/executors/parallel.ts`.
 *
 * Covers:
 *   - Output contains `{ parallel: true, branches: [...targetStepIds] }`.
 *   - tokensUsed and costUsd are always 0.
 *   - Empty nextSteps produces empty branches array.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeParallel } from '@/lib/orchestration/engine/executors/parallel';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: {},
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeParallel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns branches derived from nextSteps targetStepIds', async () => {
    const step: WorkflowStep = {
      id: 'parallel1',
      name: 'Test Parallel',
      type: 'parallel',
      config: {},
      nextSteps: [{ targetStepId: 'b' }, { targetStepId: 'c' }],
    };

    const result = await executeParallel(step, makeCtx());

    expect(result).toEqual({
      output: { parallel: true, branches: ['b', 'c'] },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('returns empty branches when nextSteps is empty', async () => {
    const step: WorkflowStep = {
      id: 'parallel1',
      name: 'Test Parallel',
      type: 'parallel',
      config: {},
      nextSteps: [],
    };

    const result = await executeParallel(step, makeCtx());

    expect(result).toEqual({
      output: { parallel: true, branches: [] },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('always returns tokensUsed: 0 and costUsd: 0', async () => {
    const step: WorkflowStep = {
      id: 'parallel1',
      name: 'Test Parallel',
      type: 'parallel',
      config: {},
      nextSteps: [{ targetStepId: 'x' }],
    };

    const result = await executeParallel(step, makeCtx());

    expect(result.tokensUsed).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('handles three or more branches', async () => {
    const step: WorkflowStep = {
      id: 'parallel1',
      name: 'Test Parallel',
      type: 'parallel',
      config: {},
      nextSteps: [
        { targetStepId: 'branch_a' },
        { targetStepId: 'branch_b' },
        { targetStepId: 'branch_c' },
      ],
    };

    const result = await executeParallel(step, makeCtx());

    expect(result.output).toEqual({
      parallel: true,
      branches: ['branch_a', 'branch_b', 'branch_c'],
    });
  });
});
