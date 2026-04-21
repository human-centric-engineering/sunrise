# Chat Interface

Reusable SSE streaming chat component for embedding in admin panels. Lives at `components/admin/orchestration/chat/chat-interface.tsx`.

## Props

| Prop                 | Type                                      | Required | Purpose                                            |
| -------------------- | ----------------------------------------- | -------- | -------------------------------------------------- |
| `agentSlug`          | `string`                                  | Yes      | Agent to call via `POST /chat/stream`              |
| `contextType`        | `string`                                  | No       | Context type forwarded in chat request             |
| `contextId`          | `string`                                  | No       | Context ID forwarded in chat request               |
| `starterPrompts`     | `string[]`                                | No       | Buttons shown when no messages exist               |
| `className`          | `string`                                  | No       | Additional classes for the outer container         |
| `embedded`           | `boolean`                                 | No       | Compact mode (no card wrapper, `h-full flex-col`)  |
| `onCapabilityResult` | `(slug: string, result: unknown) => void` | No       | Fires on `capability_result` SSE events            |
| `onStreamComplete`   | `(fullText: string) => void`              | No       | Fires with complete assistant text on `done` event |

## Modes

- **Standalone** (default): Wraps content in a card with `rounded-lg border`
- **Embedded** (`embedded={true}`): No card wrapper, fills parent height. Use inside tabs or panels.

## SSE Contract

Uses `fetch` + `ReadableStream.getReader()` (not EventSource). Parses standard SSE frames (`event:` + `data:` separated by `\n\n`). Reads `delta` field from `content` events.

Events handled: `start` (tracks conversationId), `content` (appends delta), `status` (shows status line), `capability_result` (forwards via callback), `done` (calls onStreamComplete), `error` (shows friendly fallback via `getUserFacingError()`).

Raw error text is never forwarded to the DOM. The AbortController is cleaned up on unmount.

### Reconnection

Network failures trigger up to 3 reconnect attempts with exponential backoff (1s, 2s, 4s cap). HTTP-level errors (429, 4xx, 5xx) are not retriable and show specific error messages via `getUserFacingError()`. During reconnection, a warning banner shows "Connection interrupted. Reconnecting..." with an amber `AlertTriangle` icon. After all retries are exhausted, a "Connection Lost" error is displayed. This matches the pattern in `agent-test-chat.tsx`.

## Usage

```tsx
<ChatInterface
  agentSlug="pattern-advisor"
  embedded
  starterPrompts={['Help me choose a pattern', 'Compare chain vs parallel']}
  onStreamComplete={(text) => console.log('Full response:', text)}
  className="h-[600px]"
/>
```

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface (advisor tab)
- [`../orchestration/chat.md`](../orchestration/chat.md) — Chat handler backend
- [`../api/sse.md`](../api/sse.md) — SSE helper
