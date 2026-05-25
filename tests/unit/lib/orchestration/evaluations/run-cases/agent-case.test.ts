/**
 * Unit tests for runAgentCase — thin wrapper over drainStreamChat.
 *
 * Mocks drainStreamChat at the module boundary and asserts the request
 * shape the agent-case dispatcher passes through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));

const { drainStreamChat } = await import('@/lib/orchestration/evaluations/drain-stream-chat');
const { runAgentCase } = await import('@/lib/orchestration/evaluations/run-cases/agent-case');

const mockedDrain = drainStreamChat as unknown as ReturnType<typeof vi.fn>;

function drainResult(overrides: Record<string, unknown> = {}) {
  return {
    assistantText: 'hello world',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 10, output: 5 },
    costUsd: 0.001,
    latencyMs: 42,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('runAgentCase', () => {
  it('forwards agentSlug, userId, message and forces includeTrace:true', async () => {
    mockedDrain.mockResolvedValueOnce(drainResult());

    const result = await runAgentCase({
      agentSlug: 'sales-bot',
      userId: 'user-1',
      message: 'What is the refund policy?',
    });

    expect(mockedDrain).toHaveBeenCalledTimes(1);
    const call = mockedDrain.mock.calls[0][0];
    expect(call.agentSlug).toBe('sales-bot');
    expect(call.userId).toBe('user-1');
    expect(call.message).toBe('What is the refund policy?');
    expect(call.includeTrace).toBe(true);
    expect(result.assistantText).toBe('hello world');
  });

  it('omits signal when not provided', async () => {
    mockedDrain.mockResolvedValueOnce(drainResult());

    await runAgentCase({
      agentSlug: 'a',
      userId: 'u',
      message: 'm',
    });

    const call = mockedDrain.mock.calls[0][0];
    expect(call).not.toHaveProperty('signal');
  });

  it('passes signal through when provided', async () => {
    mockedDrain.mockResolvedValueOnce(drainResult());

    const controller = new AbortController();
    await runAgentCase({
      agentSlug: 'a',
      userId: 'u',
      message: 'm',
      signal: controller.signal,
    });

    const call = mockedDrain.mock.calls[0][0];
    expect(call.signal).toBe(controller.signal);
  });

  it('returns the DrainResult shape verbatim from drainStreamChat', async () => {
    const expected = drainResult({
      errorCode: 'budget_exceeded_per_turn',
      errorMessage: 'over cap',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
    mockedDrain.mockResolvedValueOnce(expected);

    const result = await runAgentCase({
      agentSlug: 'a',
      userId: 'u',
      message: 'm',
    });

    expect(result).toEqual(expected);
  });

  it('propagates errors thrown by drainStreamChat (infra failures bubble)', async () => {
    mockedDrain.mockRejectedValueOnce(new Error('network down'));

    await expect(runAgentCase({ agentSlug: 'a', userId: 'u', message: 'm' })).rejects.toThrow(
      /network down/
    );
  });

  it('omits costLogMetadata when evaluationRunId is absent (regular chat path stays untagged)', async () => {
    mockedDrain.mockResolvedValueOnce(drainResult());

    await runAgentCase({ agentSlug: 'a', userId: 'u', message: 'm' });

    const call = mockedDrain.mock.calls[0][0];
    expect(call).not.toHaveProperty('costLogMetadata');
  });

  it('passes costLogMetadata with role=subject when evaluationRunId is provided', async () => {
    mockedDrain.mockResolvedValueOnce(drainResult());

    await runAgentCase({
      agentSlug: 'sales-bot',
      userId: 'u',
      message: 'm',
      evaluationRunId: 'run-42',
    });

    const call = mockedDrain.mock.calls[0][0];
    expect(call.costLogMetadata).toEqual({ evaluationRunId: 'run-42', role: 'subject' });
  });
});
