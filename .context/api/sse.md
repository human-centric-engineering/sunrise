# Server-Sent Events — `sseResponse` Helper

First SSE infrastructure in the repo. Bridges an `AsyncIterable<T>` to a streaming `Response` with the `text/event-stream` content type. Pure web-platform code (works in Node 18+ and the Edge runtime).

**Location:** `lib/api/sse.ts`

Reusable for any route that streams typed events. Current callers:

- **Admin chat stream** — `app/api/v1/admin/orchestration/chat/stream/route.ts` wraps an `AsyncIterable<ChatEvent>` from `streamChat()`.
- **Workflow execution** — `app/api/v1/admin/orchestration/workflows/[id]/execute/route.ts` wraps the `AsyncIterable<ExecutionEvent>` from `OrchestrationEngine.execute()` (see [`engine.md`](../orchestration/engine.md) and [`admin-api.md`](../orchestration/admin-api.md#execute-workflow-sse)).

Both consumers share the same framing, keepalive, and error-sanitization contract — any future long-running admin job (e.g. knowledge base rechunk status, bulk imports) should funnel through this helper rather than hand-rolling SSE frames.

## Signature

```typescript
export function sseResponse<T extends { type: string }>(
  events: AsyncIterable<T>,
  options?: SseResponseOptions
): Response;

interface SseResponseOptions {
  /** Interval for `: keepalive` comment frames in ms. Default 15_000. */
  keepaliveIntervalMs?: number;
  /** External abort signal — closes the stream when fired. */
  signal?: AbortSignal;
}
```

Each yielded event must have a `type: string` — it becomes the SSE `event:` line and the whole object (including `type`) is JSON-encoded as the `data:` payload.

## Event Type Sanitization

The `event.type` is validated against `/^[a-z0-9_]+$/i` before being written to the SSE `event:` line. If it contains characters outside this set (e.g. newlines, colons, or other injection vectors), it is replaced with `unknown`. This prevents SSE frame injection via crafted event types — a malicious `type` containing `\nevent: spoofed\ndata: ...` would be caught and neutralized.

## Framing Contract

One SSE frame per event:

```
event: <type>
data: <JSON payload>

```

Note the trailing blank line (`\n\n`) — this is what the `EventSource` spec uses to terminate a frame. Example for `{ type: 'content', delta: 'hello' }`:

```
event: content
data: {"type":"content","delta":"hello"}

```

## Keepalive

Every `keepaliveIntervalMs` (default 15 s) the stream emits an SSE comment frame:

```
: keepalive

```

Comment frames start with `:` and are silently ignored by browser `EventSource` clients but prevent reverse proxies (nginx, Cloudflare, AWS ALB) from timing out an idle connection mid-stream.

## Error Sanitization

If the source iterator throws, the bridge emits **one** terminal frame and closes:

```
event: error
data: {"type":"error","code":"stream_error","message":"Stream terminated unexpectedly"}

```

The raw `err.message` is **never** forwarded to the client — this is defense-in-depth on top of any upstream handler sanitization (e.g. `lib/orchestration/chat/streaming-handler.ts` sanitizes its own catch-all at the domain layer). Upstream handlers are expected to log their detailed errors via `logger.error` before throwing.

## AbortSignal

Pass `options.signal` to wire an external `AbortController` into the stream — useful for propagating `request.signal` so client disconnect tears the stream down cleanly:

```typescript
return sseResponse(streamChat({ ...body, signal: request.signal }), {
  signal: request.signal,
});
```

When the signal fires the bridge stops the keepalive timer, detaches the abort listener, and closes the stream controller. If the signal is already aborted at construction time the stream closes immediately without emitting any frames.

Consumer cancel (`reader.cancel()`) follows the same cleanup path via the `ReadableStream` `cancel()` callback.

## Response Headers

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` disables response buffering in nginx (and similar reverse proxies that honour the header) so frames ship as soon as they're enqueued.

## Worked Example

```typescript
// app/api/v1/admin/orchestration/chat/stream/route.ts
import { sseResponse } from '@/lib/api/sse';
import { streamChat } from '@/lib/orchestration/chat';

export const POST = withAdminAuth(async (request, session) => {
  const body = await validateRequestBody(request, chatStreamRequestSchema);

  const events = streamChat({
    ...body,
    userId: session.user.id,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
```

## Testing

Unit tests at `tests/unit/lib/api/sse.test.ts` cover framing, keepalive (with `vi.useFakeTimers()`), iterator throw → sanitized terminal frame, external abort, and empty-iterable close. Drain the `ReadableStream` with a small `readAll(body)` helper rather than manually reading chunks.

## Anti-Patterns

**Don't** format SSE frames by hand inside route handlers — use `sseResponse`. The keepalive and sanitization contracts are easy to forget and hard to test per-route.

**Don't** forward `err.message` in a custom error frame. If a caller needs richer error taxonomy, yield a typed error event from the source iterable (the chat handler does this with its `{ type: 'error', code, message }` events) — those pass through verbatim. The catch-all in `sseResponse` is a last-resort safety net, not a channel for domain errors.

**Don't** add SSE helpers to `lib/orchestration/`. Orchestration stays platform-agnostic; `Response` / `ReadableStream` are web-platform concerns and live in `lib/api/`.

## Chat SSE Event Types

| `type`               | Fields                        | Description                                                                                                                                   |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`              | `conversationId`, `messageId` | Emitted once after user message is persisted                                                                                                  |
| `content`            | `delta`                       | Incremental text from the LLM                                                                                                                 |
| `status`             | `message`                     | Status update (e.g. "Thinking...", "Executing tool...")                                                                                       |
| `warning`            | `code`, `message`             | Non-fatal warning (budget_warning, provider_retry, etc.)                                                                                      |
| `content_reset`      | `reason`                      | Client must discard buffered content deltas, reset typing animations, and clear displayed assistant message; follows `provider_retry` warning |
| `capability_result`  | `capabilitySlug`, `result`    | Single tool call result                                                                                                                       |
| `capability_results` | `results[]`                   | Multiple parallel tool call results                                                                                                           |
| `done`               | `tokenUsage`, `costUsd`, etc. | Normal completion                                                                                                                             |
| `error`              | `code`, `message`             | Terminal error — stream ends after this                                                                                                       |

## Related Documentation

- [Orchestration Admin API](../orchestration/admin-api.md) — chat stream and workflow execute routes
- [Streaming Chat Handler](../orchestration/chat.md) — the `AsyncIterable<ChatEvent>` source
- [Orchestration Engine](../orchestration/engine.md) — the `AsyncIterable<ExecutionEvent>` source
