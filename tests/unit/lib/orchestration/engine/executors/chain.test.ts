/**
 * Tests for `lib/orchestration/engine/executors/chain.ts`.
 *
 * Covers:
 *   - Returns `{ output: { chained: true }, tokensUsed: 0, costUsd: 0 }`.
 *   - Always resolves (never rejects).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeChain } from '@/lib/orchestration/engine/executors/chain';
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
    id: 'chain1',
    name: 'Test Chain',
    type: 'chain',
    config: { description: 'test chain', ...configOverrides },
    nextSteps: [{ targetStepId: 'step2' }, { targetStepId: 'step3' }],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { output: { chained: true }, tokensUsed: 0, costUsd: 0 }', async () => {
    const result = await executeChain(makeStep(), makeCtx());

    expect(result).toEqual({
      output: { chained: true },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('always resolves regardless of step config', async () => {
    const step = makeStep({ description: undefined });
    await expect(executeChain(step, makeCtx())).resolves.toBeDefined();
  });

  it('always resolves with an empty nextSteps list', async () => {
    const step: WorkflowStep = {
      id: 'chain1',
      name: 'Chain',
      type: 'chain',
      config: {},
      nextSteps: [],
    };
    await expect(executeChain(step, makeCtx())).resolves.toEqual({
      output: { chained: true },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('never rejects', async () => {
    await expect(executeChain(makeStep(), makeCtx())).resolves.not.toThrow();
  });
});
