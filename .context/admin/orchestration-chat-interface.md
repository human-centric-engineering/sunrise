# Chat Interface

Reusable SSE streaming chat component for embedding in admin panels. Lives at `components/admin/orchestration/chat/chat-interface.tsx`.

## Props

| Prop                     | Type                                          | Required | Default | Purpose                                            |
| ------------------------ | --------------------------------------------- | -------- | ------- | -------------------------------------------------- |
| `agentSlug`              | `string`                                      | Yes      | —       | Agent to call via `POST /chat/stream`              |
| `contextType`            | `string`                                      | No       | —       | Context type forwarded in chat request             |
| `contextId`              | `string`                                      | No       | —       | Context ID forwarded in chat request               |
| `starterPrompts`         | `string[]`                                    | No       | —       | Buttons shown when no messages exist               |
| `className`              | `string`                                      | No       | —       | Additional classes for the outer container         |
| `embedded`               | `boolean`                                     | No       | `false` | Compact mode (no card wrapper, `h-full flex-col`)  |
| `onCapabilityResult`     | `(slug: string, result: unknown) => void`     | No       | —       | Fires on `capability_result` SSE events            |
| `onStreamComplete`       | `(fullText: string) => void`                  | No       | —       | Fires with complete assistant text on `done` event |
| `enableTypingAnimation`  | `boolean`                                     | No       | `false` | Token-by-token typing animation via rAF            |
| `typingAnimationOptions` | `{ chunkSize?: number; intervalMs?: number }` | No       | —       | Typing animation speed config                      |
| `showClearButton`        | `boolean`                                     | No       | `false` | Show trash icon to clear/reset conversation        |
| `onConversationCleared`  | `() => void`                                  | No       | —       | Fires after conversation is cleared                |

## Modes

- **Standalone** (default): Wraps content in a card with `rounded-lg border`
- **Embedded** (`embedded={true}`): No card wrapper, fills parent height. Use inside tabs or panels.

## UX Features

### Typing Animation

When `enableTypingAnimation` is true, content deltas are buffered and revealed at a controlled rate via `requestAnimationFrame`, producing a natural "typing" effect. Uses the `useTypingAnimation` hook (`lib/hooks/use-typing-animation.ts`). When disabled (default), deltas are appended immediately — identical to pre-existing behavior.

### Thinking Indicator

While the assistant message is empty during streaming (agent is processing), the `ThinkingIndicator` component (`components/admin/orchestration/chat/thinking-indicator.tsx`) displays three animated bouncing dots with an optional status message (e.g., "Thinking...", "Executing search_documents"). Replaces the previous `Loader2` spinner.

### Inline Status Messages

During streaming, SSE `status` events are displayed inline within the assistant message bubble:

- **No content yet**: ThinkingIndicator shows the status text alongside animated dots
- **Content streaming**: Status appears as italic text below the content within the bubble

Status is cleared automatically when streaming completes.

### Clear Conversation

When `showClearButton` is true, a trash icon appears in the top-right of the messages area. The button is hidden while streaming to prevent state conflicts. Clicking it opens an `AlertDialog` confirmation. On confirm:

- Sends `DELETE` to the conversation endpoint (if a `conversationId` exists)
- Resets all local state (messages, error, status, warning)
- Fires `onConversationCleared` callback

## SSE Contract

Hits `POST /api/v1/admin/orchestration/chat/stream` (admin-only endpoint with `contextType`/`contextId` support). See `consumer-chat.md` for the public-facing equivalent.

Uses `fetch` + `ReadableStream.getReader()` (not EventSource). Parses standard SSE frames (`event:` + `data:` separated by `\n\n`). Reads `delta` field from `content` events.

Events handled: `start` (tracks conversationId), `content` (appends delta or buffers for animation), `content_reset` (clears accumulated text), `status` (shows inline status), `warning` (shows reconnecting banner), `capability_result` (forwards single result via callback), `capability_results` (forwards each result from parallel tools via callback), `done` (flushes animation, calls onStreamComplete), `error` (shows friendly fallback via `getUserFacingError()`).

Raw error text is never forwarded to the DOM. The AbortController is cleaned up on unmount.

### Reconnection

Network failures trigger up to 3 reconnect attempts with exponential backoff (1s, 2s, 4s cap). HTTP-level errors (429, 4xx, 5xx) are not retriable and show specific error messages via `getUserFacingError()`. During reconnection, a warning banner shows "Connection interrupted. Reconnecting..." with an amber `AlertTriangle` icon. After all retries are exhausted, a "Connection Lost" error is displayed. Note: `AgentTestChat` deliberately does **not** retry — chat POSTs are not idempotent, so retrying would duplicate the message on the server.

## Usage

```tsx
<ChatInterface
  agentSlug="pattern-advisor"
  embedded
  enableTypingAnimation
  showClearButton
  starterPrompts={['Help me choose a pattern', 'Compare chain vs parallel']}
  onStreamComplete={(text) => console.log('Full response:', text)}
  onConversationCleared={() => console.log('Conversation cleared')}
  className="h-[600px]"
/>
```

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface (advisor tab)
- [`../orchestration/chat.md`](../orchestration/chat.md) — Chat handler backend
- [`../api/sse.md`](../api/sse.md) — SSE helper
- `lib/hooks/use-typing-animation.ts` — rAF-based typing animation hook
- `components/admin/orchestration/chat/thinking-indicator.tsx` — Animated thinking dots
