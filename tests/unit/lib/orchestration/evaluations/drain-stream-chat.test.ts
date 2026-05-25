/**
 * Unit tests for drainStreamChat — the streamChat fold helper.
 *
 * Mocks streamChat at the module boundary and yields a controlled
 * ChatEvent stream. Asserts the resulting DrainResult faithfully
 * accumulates content deltas, citations, tool-call traces (only when
 * `event.trace` is set), token usage / cost (from the `done` event),
 * conversationId / messageId (from `start`), and the error fold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatEvent, Citation, ToolCallTrace } from '@/types/orchestration';

vi.mock('@/lib/orchestration/chat/streaming-handler', () => ({
  streamChat: vi.fn(),
}));

const { streamChat } = await import('@/lib/orchestration/chat/streaming-handler');
const { drainStreamChat } = await import('@/lib/orchestration/evaluations/drain-stream-chat');

const mockedStreamChat = streamChat as unknown as ReturnType<typeof vi.fn>;

function fromEvents(events: ChatEvent[]): AsyncIterable<ChatEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

const baseRequest = { agentSlug: 'a', userId: 'u', message: 'hi' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('drainStreamChat', () => {
  it('returns zeroed result on an empty stream', async () => {
    mockedStreamChat.mockReturnValueOnce(fromEvents([]));

    const result = await drainStreamChat(baseRequest);

    expect(result.assistantText).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(result.costUsd).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.conversationId).toBeUndefined();
    expect(result.messageId).toBeUndefined();
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('concatenates content deltas in stream order', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        { type: 'content', delta: 'Hello' },
        { type: 'content', delta: ', ' },
        { type: 'content', delta: 'world!' },
      ])
    );

    const result = await drainStreamChat(baseRequest);

    expect(result.assistantText).toBe('Hello, world!');
  });

  it('treats a missing/empty delta as the empty string', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        // delta typed as string in the union — pass empty string to exercise the `?? ''` arm
        { type: 'content', delta: '' },
        { type: 'content', delta: 'X' },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.assistantText).toBe('X');
  });

  it('captures conversationId and messageId from a `start` event', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([{ type: 'start', conversationId: 'conv-1', messageId: 'msg-1' }])
    );

    const result = await drainStreamChat(baseRequest);

    expect(result.conversationId).toBe('conv-1');
    expect(result.messageId).toBe('msg-1');
  });

  it('captures citations from a `citations` event', async () => {
    const citations: Citation[] = [
      {
        marker: 1,
        chunkId: 'c1',
        documentId: 'd1',
        documentName: 'Doc 1',
        contentHash: null,
        documentVersion: null,
        section: null,
        patternNumber: null,
        patternName: null,
        excerpt: 'Body.',
        similarity: 0.9,
      } as unknown as Citation,
    ];

    mockedStreamChat.mockReturnValueOnce(fromEvents([{ type: 'citations', citations }]));

    const result = await drainStreamChat(baseRequest);
    expect(result.citations).toEqual(citations);
  });

  it('overwrites citations with the latest `citations` event (not appends)', async () => {
    const first: Citation[] = [{ marker: 1, chunkId: 'c1' } as unknown as Citation];
    const second: Citation[] = [{ marker: 2, chunkId: 'c2' } as unknown as Citation];

    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        { type: 'citations', citations: first },
        { type: 'citations', citations: second },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.citations).toEqual(second);
  });

  it('ignores a citations event whose payload is not an array', async () => {
    mockedStreamChat.mockReturnValueOnce(
      // Bypass the union — runtime exercise of the `Array.isArray` guard
      fromEvents([{ type: 'citations', citations: 'oops' as unknown as Citation[] }])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.citations).toEqual([]);
  });

  it('accumulates tool-call traces only when capability_result has a trace', async () => {
    const trace: ToolCallTrace = {
      slug: 'search_knowledge_base',
      arguments: { query: 'hi' },
      latencyMs: 12,
      success: true,
    };

    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        { type: 'capability_result', capabilitySlug: 'a', result: {} },
        { type: 'capability_result', capabilitySlug: 'b', result: {}, trace },
        { type: 'capability_result', capabilitySlug: 'c', result: {} },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual(trace);
  });

  it('captures tokenUsage and costUsd from the `done` event', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        {
          type: 'done',
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          costUsd: 0.0042,
        },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
    expect(result.costUsd).toBe(0.0042);
  });

  it('falls back to 0 when done.tokenUsage fields are missing', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        // Forced cast — exercise the `?? 0` fallback arms.
        {
          type: 'done',
          tokenUsage: {} as unknown as {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
          },
          costUsd: 0,
        },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(result.costUsd).toBe(0);
  });

  it('folds error events into errorCode + errorMessage (does not throw)', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        { type: 'content', delta: 'partial' },
        { type: 'error', code: 'budget_exceeded', message: 'too expensive' },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.errorCode).toBe('budget_exceeded');
    expect(result.errorMessage).toBe('too expensive');
    // Partial content before the error is preserved.
    expect(result.assistantText).toBe('partial');
  });

  it('measures latencyMs', async () => {
    let nowCall = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCall++;
      // First call: start. Second call: end.
      return nowCall === 1 ? 1_000_000 : 1_000_250;
    });

    mockedStreamChat.mockReturnValueOnce(fromEvents([]));

    const result = await drainStreamChat(baseRequest);
    expect(result.latencyMs).toBe(250);
    spy.mockRestore();
  });

  it('rethrows infrastructure errors from the stream iterator', async () => {
    mockedStreamChat.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        throw new Error('network failure');
        // unreachable; keeps the generator typed
        yield { type: 'content', delta: '' } as ChatEvent;
      },
    });

    await expect(drainStreamChat(baseRequest)).rejects.toThrow(/network failure/);
  });

  it('ignores unknown / unhandled event types without crashing (status, warning, …)', async () => {
    mockedStreamChat.mockReturnValueOnce(
      fromEvents([
        { type: 'status', message: 'thinking' },
        { type: 'warning', code: 'soft', message: 'flag' },
        { type: 'content', delta: 'ok' },
      ])
    );

    const result = await drainStreamChat(baseRequest);
    expect(result.assistantText).toBe('ok');
  });
});
