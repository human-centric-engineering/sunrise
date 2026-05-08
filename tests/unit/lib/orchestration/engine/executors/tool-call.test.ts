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
    loadFromDatabase: vi.fn().mockResolvedValue(undefined),
    getRegistryEntry: vi.fn().mockReturnValue(undefined),
  },
}));
vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(({ executionId, stepId, turnIndex }) =>
    turnIndex !== undefined
      ? `${executionId}:${stepId}:turn=${turnIndex}`
      : `${executionId}:${stepId}`
  ),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { executeToolCall } from '@/lib/orchestration/engine/executors/tool-call';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';
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

  // ─── isIdempotent / dispatch-cache path tests ────────────────────────────────

  describe('dispatch cache integration', () => {
    // Nested beforeEach resets dispatch-cache mocks so each test starts from a
    // known baseline regardless of execution order (gotcha #22 — module-mock
    // defaults leak across describe blocks under vi.clearAllMocks()).
    beforeEach(() => {
      vi.mocked(lookupDispatch).mockReset().mockResolvedValue(null);
      vi.mocked(recordDispatch).mockReset().mockResolvedValue(true);
    });

    it('cache hit (isIdempotent: false): returns cached result, dispatch NEVER called', async () => {
      // Arrange: cache hit — a previous successful dispatch stored this result.
      // We do NOT queue a throw on dispatch — if the source short-circuits correctly,
      // dispatch is never reached and not.toHaveBeenCalled() asserts that contract.
      // A throw on a mock that is never consumed would bleed into the next test.
      const cachedResult = { output: { cached: true }, tokensUsed: 0, costUsd: 0 };
      vi.mocked(lookupDispatch).mockResolvedValueOnce(cachedResult);

      // Act
      const result = await executeToolCall(makeStep(), makeCtx());

      // Assert: the cached StepResult is returned verbatim and dispatch was skipped
      expect(result).toEqual(cachedResult);
      expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
      // Note: recordDispatch assertion omitted here — it is trivially unreachable
      // when dispatch is never called. The contract is proven by the isIdempotent=true
      // test below where dispatch IS called but recordDispatch must still be skipped.
    });

    it('cache miss (isIdempotent: false): calls dispatch and records result', async () => {
      // Arrange: cache miss (default), successful dispatch
      vi.mocked(lookupDispatch).mockResolvedValueOnce(null);
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { answer: 'yes' },
      });

      // Act
      await executeToolCall(makeStep(), makeCtx());

      // Assert: dispatch was called, then result was recorded with correct shape.
      // T2 fix: idempotencyKey is derived inside recordDispatch; callers don't pass it.
      expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(recordDispatch).toHaveBeenCalledWith({
        executionId: 'exec_1',
        stepId: 'step1',
        result: { output: { answer: 'yes' }, tokensUsed: 0, costUsd: 0 },
      });
    });

    it('isIdempotent: true — skips cache lookup, skips record, calls dispatch', async () => {
      // Arrange: registry entry declares the capability idempotent
      vi.mocked(capabilityDispatcher.getRegistryEntry).mockReturnValueOnce({
        id: 'cap-1',
        slug: 'my-tool',
        name: 'My Tool',
        category: 'utility',
        functionDefinition: { name: 'my-tool', description: '', parameters: {} },
        requiresApproval: false,
        approvalTimeoutMs: null,
        rateLimit: null,
        isIdempotent: true,
        isActive: true,
      });
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { ok: true },
      });
      // We do NOT queue throws on lookupDispatch/recordDispatch here — an unspent
      // mockImplementationOnce would bleed into the next test since isIdempotent=true
      // means those functions are never called and never consume the queued impl.
      // not.toHaveBeenCalled() below is the correct assertion for the short-circuit.

      // Act — should not throw; isIdempotent path skips the cache entirely
      const result = await executeToolCall(makeStep(), makeCtx());

      // Assert: dispatch ran and cache was entirely skipped
      expect(capabilityDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(lookupDispatch).not.toHaveBeenCalled();
      expect(recordDispatch).not.toHaveBeenCalled();
      expect(result).toEqual({ output: { ok: true }, tokensUsed: 0, costUsd: 0 });
    });

    it('registry miss (getRegistryEntry → undefined): defaults to isIdempotent=false path, lookupDispatch IS called', async () => {
      // Arrange: registry miss is the default (getRegistryEntry returns undefined)
      // lookupDispatch returns null (cache miss) so dispatch proceeds
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: {},
      });

      // Act
      await executeToolCall(makeStep(), makeCtx());

      // Assert: the conservative default (isIdempotent=false) engaged the cache lookup
      expect(lookupDispatch).toHaveBeenCalledTimes(1);
    });

    it('failed dispatch throws ExecutorError BEFORE recordDispatch is reached', async () => {
      // Arrange: dispatch returns failure
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: false,
        error: { code: 'capability_failed', message: 'Something went wrong' },
      });

      // Act + Assert: ExecutorError thrown, cache never written
      await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'capability_failed',
      });
      expect(recordDispatch).toHaveBeenCalledTimes(0);
    });

    it('transient error code (rate_limited): ExecutorError with retriable=true, no recordDispatch', async () => {
      // Arrange
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: false,
        error: { code: 'rate_limited', message: 'Too many requests' },
      });

      // Act + Assert
      await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'rate_limited',
        retriable: true,
      });
      expect(recordDispatch).toHaveBeenCalledTimes(0);
    });

    it('transient error code (execution_error): ExecutorError with retriable=true', async () => {
      // Arrange
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: false,
        error: { code: 'execution_error', message: 'Execution failed' },
      });

      // Act + Assert
      await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'execution_error',
        retriable: true,
      });
      expect(recordDispatch).toHaveBeenCalledTimes(0);
    });

    it('permanent error code (unknown_capability): ExecutorError with retriable=false, no recordDispatch', async () => {
      // Arrange
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: false,
        error: { code: 'unknown_capability', message: 'No such capability' },
      });

      // Act + Assert
      await expect(executeToolCall(makeStep(), makeCtx())).rejects.toMatchObject({
        name: 'ExecutorError',
        code: 'unknown_capability',
        retriable: false,
      });
      expect(recordDispatch).toHaveBeenCalledTimes(0);
    });

    it('recordDispatch race-loss (returns false): step still returns StepResult, no throw', async () => {
      // Arrange: dispatch succeeds, but recordDispatch signals race-loss (false = another host won)
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { value: 7 },
      });
      vi.mocked(recordDispatch).mockResolvedValueOnce(false);

      // Act — should NOT throw; losing the race is non-fatal
      const result = await executeToolCall(makeStep(), makeCtx());

      // Assert: result is returned and the executor does not treat false as an error
      expect(result).toEqual({ output: { value: 7 }, tokensUsed: 0, costUsd: 0 });
    });

    it('recordDispatch throws non-P2002: step still returns StepResult, ctx.logger.warn called', async () => {
      // Arrange: dispatch succeeds, recordDispatch throws a non-P2002 DB error
      const dbError = new Error('Connection timeout');
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: { value: 99 },
      });
      vi.mocked(recordDispatch).mockRejectedValueOnce(dbError);

      const ctx = makeCtx();

      // Act — should NOT throw; cache write failure is non-fatal
      const result = await executeToolCall(makeStep(), ctx);

      // Assert: result returned, warn logged with expected args
      expect(result).toEqual({ output: { value: 99 }, tokensUsed: 0, costUsd: 0 });
      expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'tool_call: failed to record dispatch; re-drive may re-invoke',
        { stepId: 'step1', slug: 'my-tool', error: 'Connection timeout' }
      );
    });

    it('buildIdempotencyKey called with { executionId, stepId } — no turnIndex', async () => {
      // Arrange: default successful dispatch
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: {},
      });

      // Act
      await executeToolCall(makeStep(), makeCtx());

      // Assert: key built without a turnIndex (tool_call is a single-shot step)
      expect(buildIdempotencyKey).toHaveBeenCalledWith({ executionId: 'exec_1', stepId: 'step1' });
    });

    it('loadFromDatabase called once per invocation; getRegistryEntry called with capability slug', async () => {
      // Arrange
      vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
        success: true,
        data: {},
      });

      // Act
      await executeToolCall(makeStep(), makeCtx());

      // Assert: registry hydrated once, then entry looked up by slug
      expect(capabilityDispatcher.loadFromDatabase).toHaveBeenCalledTimes(1);
      expect(capabilityDispatcher.getRegistryEntry).toHaveBeenCalledWith('my-tool');
    });
  }); // end describe('dispatch cache integration')
});
