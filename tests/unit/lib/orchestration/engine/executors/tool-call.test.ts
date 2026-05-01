/**
 * Tests for `lib/orchestration/engine/executors/tool-call.ts`.
 *
 * Covers:
 *   - Happy path: slug present, dispatch returns success.
 *   - Missing capabilitySlug → ExecutorError('missing_capability_slug').
 *   - Dispatch failure → ExecutorError wrapping the capability error code.
 *   - Custom args forwarded when config.args is set.
 *   - ctx.inputData used when config.args is absent.
 *   - agentId is `workflow:${ctx.workflowId}`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({
  registerStepType: vi.fn(),
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: {
    dispatch: vi.fn(),
  },
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeToolCall } from '@/lib/orchestration/engine/executors/tool-call';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'exec_1',
    workflowId: 'wf_tool',
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
    id: 'step1',
    name: 'Test Tool Call',
    type: 'tool_call',
    config: { capabilitySlug: 'my-tool', ...configOverrides },
    nextSteps: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns output from successful dispatch', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { result: 42 },
    });

    const result = await executeToolCall(makeStep(), makeCtx());

    expect(result).toEqual({
      output: { result: 42 },
      tokensUsed: 0,
      costUsd: 0,
    });
  });

  it('throws ExecutorError with code "missing_capability_slug" when slug is absent', async () => {
    const step = makeStep({ capabilitySlug: undefined });

    await expect(executeToolCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_capability_slug',
      stepId: 'step1',
    });
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws ExecutorError with code "missing_capability_slug" when slug is empty string', async () => {
    const step = makeStep({ capabilitySlug: '' });

    await expect(executeToolCall(step, makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'missing_capability_slug',
    });
  });

  it('throws ExecutorError using capability error code when dispatch fails', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: false,
      error: { code: 'not_found', message: 'Not found' },
    });

    await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'not_found',
      stepId: 'step1',
    });
  });

  it('falls back to "capability_failed" code when dispatch fails without error code', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: false,
      error: undefined,
    });

    await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'capability_failed',
    });
  });

  it('forwards config.args to dispatch when present', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const step = makeStep({ capabilitySlug: 'my-tool', args: { x: 1 } });
    const ctx = makeCtx();
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { x: 1 },
      expect.objectContaining({ agentId: 'workflow:wf_tool' })
    );
  });

  it('uses argsFrom step output (object) when config.args is absent', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({
      stepOutputs: { prev_step: { foo: 'bar', baz: 42 } },
    });
    const step = makeStep({ capabilitySlug: 'my-tool', argsFrom: 'prev_step' });
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { foo: 'bar', baz: 42 },
      expect.any(Object)
    );
  });

  it('wraps argsFrom step output in { data } when output is non-object (string)', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({
      stepOutputs: { prev_step: 'plain string output' },
    });
    const step = makeStep({ capabilitySlug: 'my-tool', argsFrom: 'prev_step' });
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { data: 'plain string output' },
      expect.any(Object)
    );
  });

  it('wraps argsFrom step output in { data } when output is an array', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({
      stepOutputs: { prev_step: [1, 2, 3] },
    });
    const step = makeStep({ capabilitySlug: 'my-tool', argsFrom: 'prev_step' });
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { data: [1, 2, 3] },
      expect.any(Object)
    );
  });

  it('falls back to ctx.inputData when argsFrom references a missing step', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({
      inputData: { fallback: true },
      stepOutputs: {}, // no prev_step
    });
    const step = makeStep({ capabilitySlug: 'my-tool', argsFrom: 'prev_step' });
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { fallback: true },
      expect.any(Object)
    );
  });

  it('uses ctx.inputData when config.args is not set', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({ inputData: { userId: 'abc' } });
    const step = makeStep({ capabilitySlug: 'my-tool' }); // no args
    await executeToolCall(step, ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'my-tool',
      { userId: 'abc' },
      expect.any(Object)
    );
  });

  it('sets agentId to "workflow:<workflowId>"', async () => {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: {},
    });

    const ctx = makeCtx({ workflowId: 'my-wf' });
    await executeToolCall(makeStep(), ctx);

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ agentId: 'workflow:my-wf' })
    );
  });
});
