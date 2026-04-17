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
    } as any,
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
});
