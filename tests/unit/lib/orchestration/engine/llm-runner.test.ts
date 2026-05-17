/**
 * Tests for `lib/orchestration/engine/llm-runner.ts`.
 *
 * Covers:
 *   - runLlmCall: happy path, model fallback, unknown model, provider
 *     unavailable, LLM call failure, and fire-and-forget cost logging.
 *   - interpolatePrompt: all expression forms, missing references,
 *     non-string values, and unrecognized expressions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(),
  logCost: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { runLlmCall, interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
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
    defaultErrorStrategy: 'fail',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    } as unknown as ExecutionContext['logger'],
    ...overrides,
  };
}

// ─── runLlmCall ──────────────────────────────────────────────────────────────

describe('runLlmCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: resolves with content, tokensUsed, costUsd, model', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      content: 'answer',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({ chat: mockChat } as any);
    vi.mocked(calculateCost).mockReturnValue({
      totalCostUsd: 0.001,
      isLocal: false,
      inputCostUsd: 0.0006,
      outputCostUsd: 0.0004,
    } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    const ctx = makeCtx();
    const result = await runLlmCall(ctx, {
      stepId: 's1',
      prompt: 'hi',
      modelOverride: 'gpt-4',
    });

    expect(result).toEqual({
      content: 'answer',
      tokensUsed: 15,
      costUsd: 0.001,
      model: 'gpt-4',
    });
  });

  it('falls back to default model when modelOverride is empty string', async () => {
    vi.mocked(getDefaultModelForTask).mockResolvedValue('claude-3');
    vi.mocked(getModel).mockReturnValue({ provider: 'anthropic' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    } as any);
    vi.mocked(calculateCost).mockReturnValue({
      totalCostUsd: 0.0005,
      isLocal: false,
    } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    const ctx = makeCtx();
    await runLlmCall(ctx, { stepId: 's1', prompt: 'test', modelOverride: '' });

    expect(getDefaultModelForTask).toHaveBeenCalledWith('chat');
    expect(getModel).toHaveBeenCalledWith('claude-3');
  });

  it('falls back to default model when modelOverride is undefined', async () => {
    vi.mocked(getDefaultModelForTask).mockResolvedValue('claude-3');
    vi.mocked(getModel).mockReturnValue({ provider: 'anthropic' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    } as any);
    vi.mocked(calculateCost).mockReturnValue({
      totalCostUsd: 0.0005,
      isLocal: false,
    } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    const ctx = makeCtx();
    await runLlmCall(ctx, { stepId: 's1', prompt: 'test' });

    expect(getDefaultModelForTask).toHaveBeenCalledWith('chat');
  });

  it('throws ExecutorError with code "unknown_model" when model is not in registry', async () => {
    vi.mocked(getModel).mockReturnValue(null as any);

    const ctx = makeCtx();
    await expect(
      runLlmCall(ctx, { stepId: 's1', prompt: 'test', modelOverride: 'bad-model' })
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'unknown_model',
      stepId: 's1',
    });
  });

  it('throws ExecutorError with code "provider_unavailable" when getProvider throws', async () => {
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockRejectedValue(new Error('Provider down'));

    const ctx = makeCtx();
    await expect(
      runLlmCall(ctx, { stepId: 's2', prompt: 'test', modelOverride: 'gpt-4' })
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'provider_unavailable',
      stepId: 's2',
    });
  });

  it('throws ExecutorError with code "llm_call_failed" when provider.chat rejects', async () => {
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockRejectedValue(new Error('Network error')),
    } as any);

    const ctx = makeCtx();
    await expect(
      runLlmCall(ctx, { stepId: 's3', prompt: 'test', modelOverride: 'gpt-4' })
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'llm_call_failed',
      stepId: 's3',
    });
  });

  it('pushes a telemetry entry to ctx.stepTelemetry on successful call', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      content: 'answer',
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    vi.mocked(getModel).mockReturnValue({ provider: 'anthropic' } as any);
    vi.mocked(getProvider).mockResolvedValue({ chat: mockChat } as any);
    vi.mocked(calculateCost).mockReturnValue({
      totalCostUsd: 0.001,
      isLocal: false,
    } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    const telemetry: import('@/types/orchestration').LlmTelemetryEntry[] = [];
    const ctx = makeCtx({ stepTelemetry: telemetry });
    await runLlmCall(ctx, { stepId: 's1', prompt: 'hi', modelOverride: 'claude-3-5-sonnet' });

    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      model: 'claude-3-5-sonnet',
      provider: 'anthropic',
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(telemetry[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when ctx.stepTelemetry is undefined (back-compat for callers without an array)', async () => {
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockResolvedValue({
        content: 'answer',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    } as any);
    vi.mocked(calculateCost).mockReturnValue({ totalCostUsd: 0.001, isLocal: false } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    // No `stepTelemetry` passed — the optional-chain push must be a no-op,
    // not a TypeError.
    const ctx = makeCtx();
    delete (ctx as { stepTelemetry?: unknown }).stepTelemetry;
    await expect(
      runLlmCall(ctx, { stepId: 's1', prompt: 'hi', modelOverride: 'gpt-4' })
    ).resolves.toMatchObject({ content: 'answer' });
  });

  it('swallows cost logging failure (fire-and-forget)', async () => {
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockResolvedValue({
        content: 'answer',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    } as any);
    vi.mocked(calculateCost).mockReturnValue({
      totalCostUsd: 0.001,
      isLocal: false,
    } as any);
    // logCost rejects — should be swallowed
    vi.mocked(logCost).mockRejectedValue(new Error('DB write failed'));

    const ctx = makeCtx();
    // Should resolve without throwing even though logCost rejects
    const result = await runLlmCall(ctx, {
      stepId: 's1',
      prompt: 'hi',
      modelOverride: 'gpt-4',
    });

    expect(result.content).toBe('answer');

    // Allow the micro-task queue to flush so the .catch() handler runs
    await vi.waitFor(() => {
      // test-review:accept no_arg_called — verifying fire-and-forget side-effect fired, not its payload shape
      expect(logCost).toHaveBeenCalled();
    });
  });

  it('forwards `responseFormat` to provider.chat when set on params', async () => {
    // Exercises the truthy branch of the `params.responseFormat ? { ... } : {}` spread.
    // The selector heuristic / structured-output workflows rely on this passthrough.
    const mockChat = vi.fn().mockResolvedValue({
      content: '{"ok": true}',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({ chat: mockChat } as any);
    vi.mocked(calculateCost).mockReturnValue({ totalCostUsd: 0, isLocal: false } as any);
    vi.mocked(logCost).mockResolvedValue(null as any);

    const ctx = makeCtx();
    await runLlmCall(ctx, {
      stepId: 's4',
      prompt: 'return json',
      modelOverride: 'gpt-4',
      responseFormat: { type: 'json_object' },
    });

    expect(mockChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ responseFormat: { type: 'json_object' } })
    );
  });

  it('wraps non-Error thrown values from provider.chat with a fallback message', async () => {
    // Exercises the false branch of `err instanceof Error ? err.message : 'LLM call failed'`.
    // Some providers / network layers reject with strings or plain objects.
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockRejectedValue('plain string failure' as any),
    } as any);

    const ctx = makeCtx();
    await expect(
      runLlmCall(ctx, { stepId: 's5', prompt: 'test', modelOverride: 'gpt-4' })
    ).rejects.toMatchObject({
      name: 'ExecutorError',
      code: 'llm_call_failed',
      // The fallback string is used because the rejected value is not an Error.
      message: 'LLM call failed',
    });
  });

  it('swallows non-Error rejections from logCost (fire-and-forget, fallback path)', async () => {
    // Exercises the false branch of `err instanceof Error ? err.message : String(err)`
    // inside the logCost.catch() handler — same hardening as the provider.chat path,
    // but for the cost-logging side effect.
    vi.mocked(getModel).mockReturnValue({ provider: 'openai' } as any);
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn().mockResolvedValue({
        content: 'answer',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    } as any);
    vi.mocked(calculateCost).mockReturnValue({ totalCostUsd: 0.001, isLocal: false } as any);
    // logCost rejects with a non-Error — String(err) branch handles it.

    vi.mocked(logCost).mockRejectedValue('db unreachable' as any);

    const ctx = makeCtx();
    const result = await runLlmCall(ctx, {
      stepId: 's6',
      prompt: 'hi',
      modelOverride: 'gpt-4',
    });

    expect(result.content).toBe('answer');
    // Flush microtasks so the .catch() runs and the warn log fires.
    await vi.waitFor(() => {
      // test-review:accept no_arg_called — fire-and-forget verification
      expect(logCost).toHaveBeenCalled();
    });
  });
});

// ─── interpolatePrompt ───────────────────────────────────────────────────────

describe('interpolatePrompt', () => {
  it('{{input}} → JSON.stringify of inputData object', () => {
    const ctx = makeCtx({ inputData: { q: 'hi' } });
    const result = interpolatePrompt('Query: {{input}}', ctx);
    expect(result).toBe('Query: {"q":"hi"}');
  });

  it('{{input.key}} → specific field from inputData', () => {
    const ctx = makeCtx({ inputData: { query: 'hello' } });
    const result = interpolatePrompt('{{input.query}}', ctx);
    expect(result).toBe('hello');
  });

  it('{{stepId.output}} → value from stepOutputs', () => {
    const ctx = makeCtx({ stepOutputs: { s1: 'answer' } });
    const result = interpolatePrompt('Result: {{s1.output}}', ctx);
    expect(result).toBe('Result: answer');
  });

  it('{{previous.output}} → resolved from previousStepId', () => {
    const ctx = makeCtx({ stepOutputs: { s1: 'old' } });
    const result = interpolatePrompt('Previous: {{previous.output}}', ctx, 's1');
    expect(result).toBe('Previous: old');
  });

  it('{{previous.output}} without previousStepId → empty string', () => {
    const ctx = makeCtx({ stepOutputs: { s1: 'old' } });
    const result = interpolatePrompt('Previous: {{previous.output}}', ctx);
    expect(result).toBe('Previous: ');
  });

  it('missing reference → empty string', () => {
    const ctx = makeCtx({ stepOutputs: {} });
    const result = interpolatePrompt('{{nonexistent.output}}', ctx);
    expect(result).toBe('');
  });

  it('non-string numeric value → stringified', () => {
    const ctx = makeCtx({ inputData: { count: 42 } });
    const result = interpolatePrompt('{{input.count}}', ctx);
    expect(result).toBe('42');
  });

  it('non-string object value → JSON.stringify', () => {
    const ctx = makeCtx({ inputData: { data: { nested: true } } });
    const result = interpolatePrompt('{{input.data}}', ctx);
    expect(result).toBe('{"nested":true}');
  });

  it('unrecognized expression → empty string', () => {
    const ctx = makeCtx();
    const result = interpolatePrompt('{{randomgarbage}}', ctx);
    expect(result).toBe('');
  });

  it('multiple expressions in one template', () => {
    const ctx = makeCtx({
      inputData: { name: 'Alice' },
      stepOutputs: { step1: 'draft text' },
    });
    const result = interpolatePrompt('Hello {{input.name}}, previous: {{step1.output}}', ctx);
    expect(result).toBe('Hello Alice, previous: draft text');
  });

  it('{{input}} with string inputData returns the string as-is', () => {
    const ctx = makeCtx({ inputData: 'raw string' as any });
    const result = interpolatePrompt('{{input}}', ctx);
    expect(result).toBe('raw string');
  });

  it('undefined stepOutput → empty string', () => {
    const ctx = makeCtx({ stepOutputs: {} });
    const result = interpolatePrompt('{{missingStep.output}}', ctx);
    expect(result).toBe('');
  });

  // ─── vars.<path> interpolation ─────────────────────────────────────────────

  describe('{{vars.<path>}}', () => {
    it('drills into ctx.variables along a single-segment path', () => {
      const ctx = makeCtx({ variables: { foo: 'bar' } });
      const result = interpolatePrompt('Got: {{vars.foo}}', ctx);
      expect(result).toBe('Got: bar');
    });

    it('drills into a nested path', () => {
      const ctx = makeCtx({
        variables: { __retryContext: { failureReason: 'enum mismatch', attempt: 2 } },
      });
      const result = interpolatePrompt(
        'Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}})',
        ctx
      );
      expect(result).toBe('Reason: enum mismatch (attempt 2)');
    });

    it('expands missing path to empty string', () => {
      const ctx = makeCtx({ variables: {} });
      const result = interpolatePrompt('x={{vars.missing.path}}', ctx);
      expect(result).toBe('x=');
    });

    it('does not crash when an intermediate value is null', () => {
      const ctx = makeCtx({ variables: { __retryContext: null } });
      const result = interpolatePrompt('{{vars.__retryContext.failureReason}}', ctx);
      expect(result).toBe('');
    });

    it('JSON-stringifies a non-primitive value at the resolved path', () => {
      const ctx = makeCtx({ variables: { obj: { a: 1, b: 2 } } });
      const result = interpolatePrompt('{{vars.obj}}', ctx);
      expect(result).toBe('{"a":1,"b":2}');
    });
  });

  // ─── {{#if vars.<path>}}body{{/if}} conditional blocks ─────────────────────

  describe('{{#if vars.<path>}}body{{/if}}', () => {
    it('includes the body when the path resolves to a truthy value', () => {
      const ctx = makeCtx({ variables: { __retryContext: { attempt: 1 } } });
      const result = interpolatePrompt(
        'Prefix.{{#if vars.__retryContext}} retry preamble {{/if}}Suffix.',
        ctx
      );
      expect(result).toBe('Prefix. retry preamble Suffix.');
    });

    it('omits the body when the path resolves to undefined', () => {
      const ctx = makeCtx({ variables: {} });
      const result = interpolatePrompt(
        'Prefix.{{#if vars.__retryContext}} retry preamble {{/if}}Suffix.',
        ctx
      );
      expect(result).toBe('Prefix.Suffix.');
    });

    it('omits the body when the path resolves to an empty string', () => {
      const ctx = makeCtx({ variables: { reason: '' } });
      const result = interpolatePrompt('A{{#if vars.reason}}B{{/if}}C', ctx);
      expect(result).toBe('AC');
    });

    it('omits the body when the path resolves to an empty object', () => {
      const ctx = makeCtx({ variables: { ctx: {} } });
      const result = interpolatePrompt('A{{#if vars.ctx}}B{{/if}}C', ctx);
      expect(result).toBe('AC');
    });

    it('resolves nested {{vars.<path>}} references inside the body when the conditional is true', () => {
      const ctx = makeCtx({
        variables: { __retryContext: { failureReason: 'invalid enum' } },
      });
      const result = interpolatePrompt(
        '{{#if vars.__retryContext}}Reason: {{vars.__retryContext.failureReason}}{{/if}}',
        ctx
      );
      expect(result).toBe('Reason: invalid enum');
    });

    it('handles multiple flat conditionals on the same template', () => {
      const ctx = makeCtx({ variables: { a: 1, b: '' } });
      const result = interpolatePrompt(
        '{{#if vars.a}}A{{/if}}{{#if vars.b}}B{{/if}}{{#if vars.a}}C{{/if}}',
        ctx
      );
      expect(result).toBe('AC');
    });
  });
});
