/**
 * Tests for `lib/orchestration/engine/executors/human-approval.ts`.
 *
 * Covers:
 *   - Throws PausedForApproval with prompt and previous step output.
 *   - Missing prompt → rejects with ExecutorError('missing_prompt').
 *   - No previous step output → payload has `previous: null`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeHumanApproval } from '@/lib/orchestration/engine/executors/human-approval';
import { ExecutorError, PausedForApproval } from '@/lib/orchestration/engine/errors';
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
    id: 'approval1',
    name: 'Test Approval',
    type: 'human_approval',
    config: {
      prompt: 'Approve?',
      ...configOverrides,
    },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeHumanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with PausedForApproval carrying prompt and previous step output', async () => {
    const ctx = makeCtx({ stepOutputs: { prev: 'content from prev step' } });
    const step = makeStep({ prompt: 'Approve?' });

    await expect(executeHumanApproval(step, ctx)).rejects.toBeInstanceOf(PausedForApproval);

    let thrown: unknown;
    try {
      await executeHumanApproval(step, ctx);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PausedForApproval);
    const paused = thrown as PausedForApproval;
    expect(paused.stepId).toBe('approval1');
    expect((paused.payload as Record<string, unknown>).prompt).toBe('Approve?');
    expect((paused.payload as Record<string, unknown>).previous).toBe('content from prev step');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is absent', async () => {
    const step = makeStep({ prompt: undefined });

    await expect(executeHumanApproval(step, makeCtx())).rejects.toBeInstanceOf(ExecutorError);

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
    expect((thrown as ExecutorError).stepId).toBe('approval1');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is empty string', async () => {
    const step = makeStep({ prompt: '' });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutorError);
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
  });

  it('rejects with ExecutorError("missing_prompt") when prompt is whitespace only', async () => {
    const step = makeStep({ prompt: '   ' });

    let thrown: unknown;
    try {
      await executeHumanApproval(step, makeCtx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExecutorError);
    expect((thrown as ExecutorError).code).toBe('missing_prompt');
  });

  it('payload has previous: null when there are no step outputs', async () => {
    const ctx = makeCtx({ stepOutputs: {} });

    let thrown: unknown;
    try {
      await executeHumanApproval(makeStep(), ctx);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PausedForApproval);
    const paused = thrown as PausedForApproval;
    expect((paused.payload as Record<string, unknown>).previous).toBeNull();
  });

  it('uses the last key in stepOutputs as the previous output', async () => {
    const ctx = makeCtx({
      stepOutputs: {
        step_a: 'first output',
        step_b: 'second output',
      },
    });

    let thrown: unknown;
    try {
      await executeHumanApproval(makeStep(), ctx);
    } catch (err) {
      thrown = err;
    }

    const paused = thrown as PausedForApproval;
    expect((paused.payload as Record<string, unknown>).previous).toBe('second output');
  });

  it('always rejects — never resolves', async () => {
    // Even with a valid prompt, the executor always rejects (by design).
    const result = executeHumanApproval(makeStep(), makeCtx());
    await expect(result).rejects.toBeDefined();
  });
});
