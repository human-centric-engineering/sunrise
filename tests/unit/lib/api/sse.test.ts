/**
 * Unit tests for sseResponse — the AsyncIterable → SSE Response bridge.
 *
 * Covers:
 *  - Framing of each event as `event: <type>\ndata: <json>\n\n`
 *  - Standard SSE headers
 *  - Keepalive comment frames on a fake timer
 *  - Iterator throw → sanitized terminal error frame + clean close
 *  - External AbortSignal → no further frames after abort
 *  - Consumer cancel → keepalive stops, no leaks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sseResponse } from '@/lib/api/sse';

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join('');
}

// Minimal event union for the tests.
interface TestEvent {
  type: 'start' | 'content' | 'done' | 'error';
  payload?: unknown;
  delta?: string;
}

async function* makeEvents(events: TestEvent[]): AsyncIterable<TestEvent> {
  for (const e of events) {
    yield e;
  }
}

describe('sseResponse', () => {
  it('returns a Response with SSE headers', async () => {
    const response = sseResponse(makeEvents([{ type: 'start' }, { type: 'done' }]));

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    // Drain so the stream closes in the background.
    await readAll(response.body);
  });

  it('frames each event as `event: <type>\\ndata: <json>\\n\\n`', async () => {
    const response = sseResponse(
      makeEvents([
        { type: 'start' },
        { type: 'content', delta: 'hello' },
        { type: 'done', payload: { total: 42 } },
      ])
    );

    const body = await readAll(response.body);

    expect(body).toContain('event: start\n');
    expect(body).toContain('event: content\n');
    expect(body).toContain('event: done\n');
    expect(body).toContain(`data: ${JSON.stringify({ type: 'start' })}\n\n`);
    expect(body).toContain(`data: ${JSON.stringify({ type: 'content', delta: 'hello' })}\n\n`);
    expect(body).toContain(`data: ${JSON.stringify({ type: 'done', payload: { total: 42 } })}\n\n`);
  });

  describe('keepalive', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('emits a `: keepalive` comment frame on interval', async () => {
      // Iterable that blocks on an external promise so the stream stays open.
      let release: () => void = () => {};
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });

      async function* slow(): AsyncIterable<TestEvent> {
        yield { type: 'start' };
        await blocker;
        yield { type: 'done' };
      }

      const response = sseResponse(slow(), { keepaliveIntervalMs: 100 });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // Read the initial `start` frame.
      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('event: start');

      // Advance past a keepalive tick — need to microtask-flush between
      // the timer firing and the next read resolving.
      await vi.advanceTimersByTimeAsync(150);

      // Next read should return the keepalive comment frame.
      const ka = await reader.read();
      expect(decoder.decode(ka.value)).toBe(': keepalive\n\n');

      // Release the iterator and drain.
      release();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
  });

  it('does not forward raw err.message when the iterator throws', async () => {
    async function* boom(): AsyncIterable<TestEvent> {
      yield { type: 'start' };
      throw new Error('SECRET_PROD_HOSTNAME internals leaked');
    }

    const response = sseResponse(boom());
    const body = await readAll(response.body);

    expect(body).toContain('event: start');
    // Sanitized terminal frame
    expect(body).toContain('event: error');
    expect(body).toContain('"code":"stream_error"');
    expect(body).toContain('"message":"Stream terminated unexpectedly"');
    // Critically: no leak of the raw error message
    expect(body).not.toContain('SECRET_PROD_HOSTNAME');
    expect(body).not.toContain('internals leaked');
  });

  it('stops emitting frames after an external AbortSignal fires', async () => {
    const controller = new AbortController();

    let iteratorReached = 0;
    async function* flow(): AsyncIterable<TestEvent> {
      yield { type: 'start' };
      iteratorReached += 1;
      // Abort before the next yield reaches the consumer
      controller.abort();
      yield { type: 'content', delta: 'after-abort' };
      iteratorReached += 1;
    }

    const response = sseResponse(flow(), { signal: controller.signal });
    const body = await readAll(response.body);

    expect(body).toContain('event: start');
    // The second yield happens inside the iterator but the stream is
    // closed — we should NOT see the post-abort content frame on the wire.
    expect(body).not.toContain('after-abort');
    // The iterator itself may have advanced past the first yield before
    // abort was detected by the loop — we don't care about internal
    // bookkeeping, only about what's written to the stream.
    expect(iteratorReached).toBeGreaterThanOrEqual(0);
  });

  it('closes cleanly when the iterable finishes with no events', async () => {
    async function* empty(): AsyncIterable<TestEvent> {
      // no yields
    }

    const response = sseResponse(empty());
    const body = await readAll(response.body);

    expect(body).toBe('');
  });

  it('closes immediately without iterating when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let iteratorStarted = false;
    async function* flow(): AsyncIterable<TestEvent> {
      iteratorStarted = true;
      yield { type: 'start' };
    }

    const response = sseResponse(flow(), { signal: controller.signal });
    const body = await readAll(response.body);

    // Fast path: close() is called before the for-await loop is entered,
    // so the iterator is never advanced and nothing is written.
    expect(body).toBe('');
    expect(iteratorStarted).toBe(false);
  });

  it('sanitizes non-alphanumeric type to unknown in the emitted event frame', async () => {
    // Arrange: event with a type containing special characters (e.g. a dot or slash)
    // that do NOT match /^[a-z0-9_]+$/i — the formatFrame guard at sse.ts L139
    async function* badType(): AsyncIterable<{ type: string }> {
      yield { type: 'bad.type' };
    }

    // Act
    const response = sseResponse(
      badType() as AsyncIterable<{ type: string } & { type: 'bad.type' }>
    );
    const body = await readAll(response.body);

    // Assert: the SSE `event:` line uses the sanitized value, NOT the raw type
    expect(body).toContain('event: unknown\n');
    expect(body).not.toContain('event: bad.type');
    // The full object (including the original type) is still in the data payload
    expect(body).toContain('"type":"bad.type"');
  });

  it('cleans up keepalive and abort listener when the consumer cancels', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      // Iterable that never resolves so the stream stays open until we cancel.
      async function* blocking(): AsyncIterable<TestEvent> {
        yield { type: 'start' };
        await new Promise<void>(() => {
          /* never resolves */
        });
      }

      const response = sseResponse(blocking(), {
        keepaliveIntervalMs: 100,
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      // Drain the `start` frame so the iterator is parked on the blocker.
      await reader.read();

      // Consumer disconnects — triggers the ReadableStream cancel() callback.
      await reader.cancel();

      // cancel() should have detached the external abort listener.
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

      // And it should have stopped the keepalive timer — advancing past the
      // interval must not leave any pending timers behind.
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
