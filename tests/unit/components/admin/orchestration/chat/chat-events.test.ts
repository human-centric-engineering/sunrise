/**
 * Unit tests for the shared admin chat SSE event validator.
 *
 * The validator is the single boundary between raw SSE frames and
 * strongly-typed UI state — keep these tests focused on (1) field
 * narrowing, (2) the new `trace` shape that admin surfaces depend on,
 * and (3) defensive rejection of malformed payloads so a server-side
 * regression cannot crash the client.
 */

import { describe, expect, it } from 'vitest';

import {
  parseChatStreamEvent,
  type ChatStreamEvent,
} from '@/components/admin/orchestration/chat/chat-events';
import type { ChatEvent } from '@/types/orchestration';

/**
 * Compile-time drift guard (#461).
 *
 * The client schema is a hand-maintained mirror of the canonical `ChatEvent`
 * union. When they drifted, `parseChatStreamEvent` returned null for the
 * unmodelled variant and consumers silently dropped a terminal frame — a
 * failure with no runtime signal at all. Both aliases resolve to `never` only
 * while each side covers the other, so the annotations below stop compiling the
 * moment a variant is added to one side alone.
 */
type UnmodelledByClient = Exclude<ChatEvent['type'], ChatStreamEvent['type']>;
type UnknownToServer = Exclude<ChatStreamEvent['type'], ChatEvent['type']>;

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}`;
}

describe('parseChatStreamEvent', () => {
  it('parses a capability_result without trace (consumer-shape default)', () => {
    const parsed = parseChatStreamEvent(
      frame('capability_result', {
        type: 'capability_result',
        capabilitySlug: 'search_knowledge_base',
        result: { success: true, data: { results: [] } },
      })
    );
    expect(parsed).not.toBeNull();
    if (!parsed || parsed.type !== 'capability_result') throw new Error('wrong variant');
    expect(parsed.capabilitySlug).toBe('search_knowledge_base');
    expect(parsed.trace).toBeUndefined();
  });

  it('parses a capability_result with a full trace object', () => {
    const parsed = parseChatStreamEvent(
      frame('capability_result', {
        type: 'capability_result',
        capabilitySlug: 'lookup_order',
        result: { success: true, data: { id: 'o_1' } },
        trace: {
          slug: 'lookup_order',
          arguments: { orderId: 'o_1' },
          latencyMs: 142,
          success: true,
          resultPreview: '{"success":true,"data":{"id":"o_1"}}',
        },
      })
    );
    if (!parsed || parsed.type !== 'capability_result') throw new Error('wrong variant');
    expect(parsed.trace?.slug).toBe('lookup_order');
    expect(parsed.trace?.latencyMs).toBe(142);
    expect(parsed.trace?.success).toBe(true);
    expect(parsed.trace?.errorCode).toBeUndefined();
  });

  it('parses a failing capability_result trace with errorCode', () => {
    const parsed = parseChatStreamEvent(
      frame('capability_result', {
        type: 'capability_result',
        capabilitySlug: 'lookup_order',
        result: { success: false, error: { code: 'not_found', message: 'no such order' } },
        trace: {
          slug: 'lookup_order',
          arguments: { orderId: 'missing' },
          latencyMs: 18,
          success: false,
          errorCode: 'not_found',
        },
      })
    );
    if (!parsed || parsed.type !== 'capability_result') throw new Error('wrong variant');
    expect(parsed.trace?.success).toBe(false);
    expect(parsed.trace?.errorCode).toBe('not_found');
  });

  it('parses a parallel capability_results batch with per-entry trace', () => {
    const parsed = parseChatStreamEvent(
      frame('capability_results', {
        type: 'capability_results',
        results: [
          {
            capabilitySlug: 'a',
            result: { success: true },
            trace: { slug: 'a', arguments: {}, latencyMs: 30, success: true },
          },
          {
            capabilitySlug: 'b',
            result: { success: true },
            trace: { slug: 'b', arguments: {}, latencyMs: 30, success: true },
          },
        ],
      })
    );
    if (!parsed || parsed.type !== 'capability_results') throw new Error('wrong variant');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].trace?.slug).toBe('a');
    expect(parsed.results[1].trace?.slug).toBe('b');
  });

  it('rejects a trace with negative latency', () => {
    const parsed = parseChatStreamEvent(
      frame('capability_result', {
        type: 'capability_result',
        capabilitySlug: 'x',
        result: {},
        trace: { slug: 'x', arguments: {}, latencyMs: -1, success: true },
      })
    );
    expect(parsed).toBeNull();
  });

  it('returns null for unknown event types so callers ignore them', () => {
    expect(
      parseChatStreamEvent(frame('some_future_event', { type: 'some_future_event' }))
    ).toBeNull();
  });

  it('returns null for an unparseable frame (no event line)', () => {
    expect(parseChatStreamEvent('data: {"type":"content","delta":"hi"}')).toBeNull();
  });

  it('parses citations with full hybrid-score metadata', () => {
    const parsed = parseChatStreamEvent(
      frame('citations', {
        type: 'citations',
        citations: [
          {
            marker: 1,
            chunkId: 'c1',
            documentId: 'd1',
            documentName: 'Guide',
            contentHash: 'sha256-abc',
            documentVersion: null,
            section: 'Intro',
            patternNumber: null,
            patternName: null,
            excerpt: 'lorem',
            similarity: 0.83,
            vectorScore: 0.81,
            keywordScore: 0.65,
            finalScore: 0.83,
          },
        ],
      })
    );
    if (!parsed || parsed.type !== 'citations') throw new Error('wrong variant');
    expect(parsed.citations[0].marker).toBe(1);
    expect(parsed.citations[0].similarity).toBeCloseTo(0.83);
  });
});

describe('done event', () => {
  it('preserves finishReason so a consumer can tell a truncated turn (#594)', () => {
    // Zod objects are NON-STRICT: an unmodelled field is silently stripped,
    // not rejected. So when `ChatEvent.done` gained `finishReason`, the server
    // advertised it (sse.md, consumer-chat.md) while every consumer of
    // `parseChatStreamEvent` read `undefined` — a contract that looks whole
    // and is not, with no runtime signal anywhere.
    //
    // The compile-time drift guard above cannot catch this class: it compares
    // the union's `type` NAMES, so a new field on an existing variant passes
    // it untouched. This is the runtime half.
    const event = parseChatStreamEvent(
      `event: done\ndata: ${JSON.stringify({
        type: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 1000, totalTokens: 1010 },
        costUsd: 0.002,
        finishReason: 'length',
      })}`
    );

    expect(event).not.toBeNull();
    expect(event).toMatchObject({ type: 'done', finishReason: 'length' });
  });

  it('accepts a done frame with no finishReason — the field is optional', () => {
    const event = parseChatStreamEvent(
      `event: done\ndata: ${JSON.stringify({
        type: 'done',
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        costUsd: 0,
      })}`
    );

    expect(event).toMatchObject({ type: 'done' });
    expect((event as { finishReason?: string }).finishReason).toBeUndefined();
  });

  it('rejects a finishReason outside the provider enum', () => {
    const event = parseChatStreamEvent(
      `event: done\ndata: ${JSON.stringify({
        type: 'done',
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        costUsd: 0,
        finishReason: 'exploded',
      })}`
    );

    expect(event).toBeNull();
  });
});

describe('schema/type parity', () => {
  it('covers the canonical ChatEvent union in both directions', () => {
    // The assertion is the type annotation, not the runtime value: either
    // alias resolving to anything but `never` makes this file fail to compile.
    const everyServerEventIsModelled: UnmodelledByClient extends never ? true : never = true;
    const noInventedClientEvents: UnknownToServer extends never ? true : never = true;

    expect(everyServerEventIsModelled).toBe(true);
    expect(noInventedClientEvents).toBe(true);
  });
});

describe('budget_exceeded_per_turn', () => {
  it('parses the cap event so consumers can surface it', () => {
    // Regression (#461): the variant was missing from the union, so the
    // parser returned null and every consumer dropped the frame. On the
    // tool-loop-abort path it is the LAST frame sent — no `done`/`error`
    // follows — so dropping it leaves an empty turn and no explanation.
    const parsed = parseChatStreamEvent(
      frame('budget_exceeded_per_turn', {
        type: 'budget_exceeded_per_turn',
        code: 'budget_exceeded_per_turn',
        message: 'This response exceeded the per-turn cost limit of $0.5000.',
        usedUsd: 0.7312,
        limitUsd: 0.5,
      })
    );

    if (!parsed || parsed.type !== 'budget_exceeded_per_turn') throw new Error('wrong variant');
    expect(parsed.message).toContain('per-turn cost limit');
    expect(parsed.usedUsd).toBeCloseTo(0.7312);
    expect(parsed.limitUsd).toBeCloseTo(0.5);
  });

  it('rejects a cap event missing the cost figures', () => {
    // The emitter always sends both; a frame without them is malformed
    // rather than a shape we should half-render.
    const parsed = parseChatStreamEvent(
      frame('budget_exceeded_per_turn', {
        type: 'budget_exceeded_per_turn',
        code: 'budget_exceeded_per_turn',
        message: 'capped',
      })
    );

    expect(parsed).toBeNull();
  });
});
