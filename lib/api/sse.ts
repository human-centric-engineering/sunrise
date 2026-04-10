/**
 * Server-Sent Events bridge
 *
 * Converts an `AsyncIterable<T>` into a streaming `Response` with the
 * `text/event-stream` content type. Each event becomes a single SSE
 * frame (`event:` + `data:`), and the stream emits periodic keepalive
 * comment frames so upstream proxies don't time out mid-stream.
 *
 * Design notes:
 * - Pure web-platform code (ReadableStream, Response, TextEncoder) —
 *   works in Node 18+ and the Edge runtime.
 * - Never forwards a raw error message to the client. If the source
 *   iterator throws, we emit one terminal sanitized error frame before
 *   closing. This is defense-in-depth on top of any upstream handler
 *   sanitization (e.g. `streaming-handler.ts`'s catch-all).
 * - Honours an optional external `AbortSignal`. When aborted, the
 *   stream is closed cleanly — no further frames are emitted.
 *
 * Event shape: the input iterable yields `{ type: string, ... }`
 * objects. `type` becomes the SSE `event:` line; the entire object
 * (including `type`) is JSON-encoded as the `data:` payload.
 */

const DEFAULT_KEEPALIVE_MS = 15_000;
const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disables response buffering in nginx and similar reverse proxies.
  'X-Accel-Buffering': 'no',
};

const TERMINAL_ERROR_FRAME = formatFrame({
  type: 'error',
  code: 'stream_error',
  message: 'Stream terminated unexpectedly',
});

export interface SseResponseOptions {
  /** Interval for `: keepalive` comment frames in ms. Default 15_000. */
  keepaliveIntervalMs?: number;
  /** External abort signal — closes the stream when fired. */
  signal?: AbortSignal;
}

export function sseResponse<T extends { type: string }>(
  events: AsyncIterable<T>,
  options: SseResponseOptions = {}
): Response {
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
  const externalSignal = options.signal;
  const encoder = new TextEncoder();

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let abortListener: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (abortListener && externalSignal) {
          externalSignal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
        try {
          controller.close();
        } catch {
          // Controller may already be closed if the consumer disconnected.
        }
      };

      // Keepalive: SSE comment frames starting with `:` are ignored by
      // EventSource clients but prevent proxies from timing out.
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          // If enqueue fails the stream is closing — let close() handle it.
        }
      }, keepaliveIntervalMs);

      // External abort wiring
      if (externalSignal) {
        if (externalSignal.aborted) {
          close();
          return;
        }
        abortListener = () => close();
        externalSignal.addEventListener('abort', abortListener, { once: true });
      }

      try {
        for await (const event of events) {
          if (closed) break;
          controller.enqueue(encoder.encode(formatFrame(event)));
        }
      } catch {
        // Source iterator threw. Emit a sanitized terminal frame — we
        // NEVER forward the raw error message to the client. Upstream
        // handlers are expected to log their own errors before throwing.
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(TERMINAL_ERROR_FRAME));
          } catch {
            // controller unusable; fall through to close()
          }
        }
      } finally {
        close();
      }
    },
    cancel() {
      // Consumer disconnected — stop keepalive, detach abort listener.
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (abortListener && externalSignal) {
        externalSignal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function formatFrame<T extends { type: string }>(event: T): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
