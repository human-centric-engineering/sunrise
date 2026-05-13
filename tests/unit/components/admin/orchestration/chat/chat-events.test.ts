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

import { parseChatStreamEvent } from '@/components/admin/orchestration/chat/chat-events';

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
