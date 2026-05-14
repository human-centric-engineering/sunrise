# Chat Interface

Reusable SSE streaming chat component for embedding in admin panels. Lives at `components/admin/orchestration/chat/chat-interface.tsx`.

## Props

| Prop                     | Type                                          | Required | Default | Purpose                                                                                                              |
| ------------------------ | --------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `agentSlug`              | `string`                                      | Yes      | —       | Agent to call via `POST /chat/stream`                                                                                |
| `agentId`                | `string`                                      | No       | —       | Agent row id — required alongside `voiceInputEnabled` to render the mic. Sent to `/chat/transcribe` for routing.     |
| `voiceInputEnabled`      | `boolean`                                     | No       | `false` | Opt-in flag for the mic affordance. See [Voice input](#voice-input) below.                                           |
| `contextType`            | `string`                                      | No       | —       | Context type forwarded in chat request                                                                               |
| `contextId`              | `string`                                      | No       | —       | Context ID forwarded in chat request                                                                                 |
| `starterPrompts`         | `string[]`                                    | No       | —       | Buttons shown when no messages exist                                                                                 |
| `className`              | `string`                                      | No       | —       | Additional classes for the outer container                                                                           |
| `embedded`               | `boolean`                                     | No       | `false` | Compact mode (no card wrapper, `h-full flex-col`)                                                                    |
| `onCapabilityResult`     | `(slug: string, result: unknown) => void`     | No       | —       | Fires on `capability_result` SSE events                                                                              |
| `onStreamComplete`       | `(fullText: string) => void`                  | No       | —       | Fires with complete assistant text on `done` event                                                                   |
| `enableTypingAnimation`  | `boolean`                                     | No       | `false` | Token-by-token typing animation via rAF                                                                              |
| `typingAnimationOptions` | `{ chunkSize?: number; intervalMs?: number }` | No       | —       | Typing animation speed config                                                                                        |
| `showClearButton`        | `boolean`                                     | No       | `false` | Show trash icon to clear/reset conversation                                                                          |
| `onConversationCleared`  | `() => void`                                  | No       | —       | Fires after conversation is cleared                                                                                  |
| `showInlineTrace`        | `boolean`                                     | No       | `false` | Admin-only diagnostic. Sends `includeTrace: true` and renders `<MessageTrace>` per assistant turn.                   |
| `suggestionPool`         | `readonly string[]`                           | No       | —       | Pool of suggestion strings drawn by the in-chat lightbulb button (visible once messages exist). Click → random fill. |
| `onResampleStarters`     | `() => void`                                  | No       | —       | When set, renders a shuffle icon next to "Try asking:" that invokes this callback. Parent owns the resample logic.   |

## Modes

- **Standalone** (default): Wraps content in a card with `rounded-lg border`
- **Embedded** (`embedded={true}`): No card wrapper, fills parent height. Use inside tabs or panels.

## UX Features

### Typing Animation

When `enableTypingAnimation` is true, content deltas are buffered and revealed at a controlled rate via `requestAnimationFrame`, producing a natural "typing" effect. Uses the `useTypingAnimation` hook (`lib/hooks/use-typing-animation.ts`). When disabled (default), deltas are appended immediately — identical to pre-existing behavior.

### Input focus retention

The `<Input>` is `disabled={streaming}` while a turn is in flight, which drops focus when streaming starts. A `wasStreamingRef` tracks the previous streaming value and a `useEffect` calls `inputRef.current?.focus()` on the streaming → idle transition only — not on initial mount, which would steal focus from other elements when the chat is rendered as part of a larger page (e.g. the Learning Hub tabs). Result: the cursor stays in the input across turns so users can keep typing without clicking back in. `AgentTestChat` follows the same pattern on its `<Textarea>`.

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

### Voice input

When both `voiceInputEnabled` and `agentId` are truthy, a `<MicButton>` (`components/admin/orchestration/chat/mic-button.tsx`) renders between the text input and the Send button. Same gate as `AgentTestChat`, which is the canonical reference for the affordance.

- Audio is uploaded to `/api/v1/admin/orchestration/chat/transcribe` with the `agentId` so the route can resolve the agent's `enableVoiceInput` and `voiceInputGloballyEnabled` settings.
- Returned transcripts are **appended** to whatever the operator has already typed (`'currentText hello from the mic'`), not replaced — operators can mix typing and dictation in a single turn. An empty input writes the transcript verbatim with no leading space.
- Mic errors (microphone access denied, transcription failed, etc.) surface through the same error banner the SSE path uses: title "Voice input failed", body = the upstream message.

Callers without an agent row (e.g. legacy callers that only know the slug) keep their text-only UX — defaults are off so the affordance is strictly opt-in. The Learning Hub server-fetches both agent records (`pattern-advisor`, `quiz-master`) and threads them through `LearningTabs` → `ChatInterface` so each tab respects its agent's voice toggle independently.

## SSE Contract

Hits `POST /api/v1/admin/orchestration/chat/stream` (admin-only endpoint with `contextType`/`contextId` support). See `consumer-chat.md` for the public-facing equivalent.

Uses `fetch` + `ReadableStream.getReader()` (not EventSource). Parses standard SSE frames (`event:` + `data:` separated by `\n\n`). Reads `delta` field from `content` events.

Events handled: `start` (tracks conversationId), `content` (appends delta or buffers for animation), `content_reset` (clears accumulated text), `status` (shows inline status), `warning` (shows reconnecting banner), `capability_result` (forwards single result via callback), `capability_results` (forwards each result from parallel tools via callback), `done` (flushes animation, calls onStreamComplete), `error` (shows friendly fallback via `getUserFacingError()`).

Raw error text is never forwarded to the DOM. The AbortController is cleaned up on unmount.

### Reconnection

Network failures trigger up to 3 reconnect attempts with exponential backoff (1s, 2s, 4s cap). HTTP-level errors (429, 4xx, 5xx) are not retriable and show specific error messages via `getUserFacingError()`. During reconnection, a warning banner shows "Connection interrupted. Reconnecting..." with an amber `AlertTriangle` icon. After all retries are exhausted, a "Connection Lost" error is displayed. Note: `AgentTestChat` deliberately does **not** retry — chat POSTs are not idempotent, so retrying would duplicate the message on the server.

### Suggested-prompts disclosure (post-first-turn)

Once the conversation has at least one message, the pre-conversation "Try asking:" grid is hidden. In its place a collapsible **Suggested prompts** disclosure appears beneath the top action cluster:

- Chevron toggle on the left; default closed so it doesn't compete with the assistant body.
- **Auto-randomises on every open** when `onResampleStarters` is provided — the callback fires on the closed → open transition only (closing is a no-op). Surfaces without a resample handler (e.g. quiz) just toggle the panel; the static prompts stay put.
- Shuffle icon next to the toggle — only renders when `onResampleStarters` is provided. Useful for explicit re-rolls while the panel is already open. (Quiz Master keeps its static four prompts and gets no shuffle; the advisor reuses its pool sampler.)
- Expanding the disclosure reveals the same `starterPrompts` as buttons. Clicking one sends it as a fresh user turn and closes the panel implicitly on the next render (the panel hides while streaming).

Hidden during streaming so the toggle button doesn't fight whichever in-flight controls are active.

### Suggest-a-prompt button (`suggestionPool`)

A small lightbulb icon button rendered in the input row when (a) `suggestionPool` is non-empty and (b) the conversation has at least one message. Click → random pool entry replaces the textarea value (focus returns to the textarea so the operator can edit before sending). Hidden while streaming.

Independent of `starterPrompts`: the starter grid is the pre-conversation affordance shown when `messages.length === 0`; the lightbulb button is the mid-conversation re-roll. Both should usually draw from the same pool — the Learning Lab advisor wires both from `lib/orchestration/learn/advisor-prompts.ts`.

The button is generic — any caller can pass a `suggestionPool` to get the same affordance. Not enabled by default.

### Inline trace annotations (`showInlineTrace`)

Admin-only. When `true`, the chat:

1. Sets `includeTrace: true` on the POST body so the streaming handler attaches a `trace` field to each `capability_result` event (validated args, `latencyMs`, `success`, optional `errorCode`, `resultPreview`).
2. Routes every SSE frame through the validated parser at `components/admin/orchestration/chat/chat-events.ts` (Zod-typed) — never reads raw `parseSseBlock` output for trace fields.
3. Accumulates traces onto the in-flight assistant message in component state.
4. Renders `<MessageTrace>` (`components/admin/orchestration/chat/message-trace.tsx`) below the bubble: collapsed strip shows "N tools · totalLatency"; expanded view shows per-tool cards with slug pill, latency, optional cost, arguments JSON, and a result preview.

The strip is also rendered post-hoc by `conversation-trace-viewer.tsx` from the persisted `metadata.toolCalls` on the terminal assistant message, so the same component covers live + replay views.

Currently enabled on: the Learning Lab pattern advisor + quiz, the agent test tab on the agent edit form, and the evaluation runner. All three are admin-only routes; do not enable on consumer surfaces — the strip exposes raw tool arguments and internal slugs.

See `.context/orchestration/chat.md#inline-trace-annotations-admin-only` for the wire-shape contract and the consumer-route redaction guarantee.

## Usage

```tsx
<ChatInterface
  agentSlug="pattern-advisor"
  embedded
  enableTypingAnimation
  showClearButton
  showInlineTrace
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
