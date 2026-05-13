# Streaming Chat Handler

Platform-agnostic runtime that runs a single chat turn against an agent — load the agent, build the message array, stream from the LLM, dispatch any tool calls mid-stream, persist everything, and emit a typed `AsyncIterable<ChatEvent>`. Implemented in `lib/orchestration/chat/`.

The handler is the consumer of every prior orchestration slice: it calls `providerManager.getProvider`, `capabilityDispatcher.dispatch`, and `costTracker.logCost` around a persisted `AiConversation` + `AiMessage` record. **SSE framing happens in the API route layer** (Session 3.3), never here — the handler only yields plain events.

## Quick Start

```typescript
import { streamChat } from '@/lib/orchestration/chat';

for await (const event of streamChat({
  message: 'Explain the ReAct pattern',
  agentSlug: 'pattern-coach',
  userId: 'user-1',
  contextType: 'pattern',
  contextId: '1',
})) {
  switch (event.type) {
    case 'start':
      console.log('conversation', event.conversationId);
      break;
    case 'content':
      process.stdout.write(event.delta);
      break;
    case 'status':
      console.log('\n[status]', event.message);
      break;
    case 'capability_result':
      console.log('\n[tool]', event.capabilitySlug, event.result);
      break;
    case 'done':
      console.log('\n[done]', event.tokenUsage, event.costUsd);
      break;
    case 'error':
      console.error('\n[error]', event.code, event.message);
      break;
  }
}
```

`streamChat` is a thin wrapper around `new StreamingChatHandler().run(request)`. The iterator **always terminates cleanly** — every error path yields a final `{ type: 'error' }` event before returning, so consumers don't need try/catch around the loop.

## Public Surface

Everything is exported from `@/lib/orchestration/chat`:

| Export                 | Kind     | Purpose                                                                     |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `streamChat`           | function | Convenience wrapper around `StreamingChatHandler.run`                       |
| `StreamingChatHandler` | class    | Main handler. Instantiate and call `.run(request)` for multiple invocations |
| `ChatError`            | class    | Narrow error type with `code` + `message`, caught by the outer try          |
| `ChatRequest`          | type     | Input shape (see below)                                                     |
| `ChatStream`           | type     | Alias for `AsyncIterable<ChatEvent>`                                        |
| `MAX_TOOL_ITERATIONS`  | const    | Tool loop cap (currently `5`)                                               |
| `MAX_HISTORY_MESSAGES` | const    | History truncation target (currently `50`)                                  |
| `buildContext`         | function | Loads and frames entity context with a 60 s TTL cache                       |
| `invalidateContext`    | function | Drop a single cache entry after a mutating capability                       |
| `clearContextCache`    | function | Wipe the entire cache (tests and admin hooks)                               |

`buildMessages` and the internal `PersistMessageParams` type are **not** re-exported — the public surface is deliberately small.

## `ChatRequest`

```typescript
interface ChatRequest {
  message: string;
  agentSlug: string;
  userId: string;
  conversationId?: string;
  contextType?: string;
  contextId?: string;
  entityContext?: Record<string, unknown>;
  attachments?: { name: string; mimeType: string; data: string }[];
  requestId?: string;
  signal?: AbortSignal;
  includeTrace?: boolean;
}
```

- Omit `conversationId` to create a new `AiConversation` — `contextType` and `contextId` are persisted on the row at creation time only.
- Supply `conversationId` to continue an existing conversation. Mismatched `userId` / `agentId` → `conversation_not_found`.
- `entityContext` is opaque to the handler — it's passed straight through to `CapabilityContext.entityContext` so capabilities can read it.
- `requestId` is a correlation ID for structured log tracing. When provided, the handler creates a scoped logger via `logger.withContext({ requestId })` so all log entries from the chat turn are traceable. The chat stream route extracts this from the `x-request-id` header automatically.
- `signal` is forwarded into every `provider.chatStream` call.
- `includeTrace` is the admin-only opt-in for inline tool-call diagnostics. See [Inline trace annotations](#inline-trace-annotations-admin-only) below.

## `ChatEvent` Lifecycle

All events are defined in `types/orchestration.ts`. Every turn produces this ordered sequence (zero or more `content` in place of `content*`):

```
start → [warning]? → content* → [content_reset → content*]? → [status → capability_result → (content* | done)]* → [citations]? → (done | error)
```

`warning` and `content_reset` can appear at any point in the sequence; the diagram above shows their most common positions.

Concretely:

1. **`start`** — always emitted first, once the user message has been persisted and the conversation resolved. Carries `conversationId` and the persisted user `messageId`.
2. **`content`** — zero or more. One per `text` chunk from the provider. The `delta` is the incremental text; concatenate for the full assistant message.
3. **`status`** — emitted before each LLM turn (`Thinking...` for the first, `Processing tool results...` for follow-ups) and before dispatching a tool call (e.g. `Executing search_knowledge_base`).
4. **`capability_result`** — emitted after the dispatcher resolves. Carries `capabilitySlug` and the raw `CapabilityResult` object (including any `success: false` gates like `requires_approval`). For citation-producing capabilities (currently `search_knowledge_base`), each result item is augmented with a `marker: number` field — see [Citations](#citations) below.
5. **Loop or terminate** — if the `CapabilityResult.skipFollowup` flag is true, emit `done` and return. Otherwise the handler rebuilds the message array with `assistant` + `tool` turns appended and runs another LLM turn. Up to `MAX_TOOL_ITERATIONS` turns per request.
6. **`citations`** — emitted once at the end of the turn (just before `done`) when at least one citation-producing tool returned results. Carries the full `Citation[]` envelope keyed by the markers that appear in the assistant text. Skipped when no citations were produced.
7. **`done`** — terminal. Carries `tokenUsage` (sum for the final turn), `costUsd` (final turn cost only), `provider` (the resolved provider slug, useful when fallback activated), and `model` (the model id used).
8. **`error`** — terminal alternative. Carries a stable `code` and user-safe `message`. See "Error codes" below.
9. **`warning`** — non-terminal, may appear at any point. Carries `code` and `message`. Codes: `budget_warning` (agent at ≥80% spend), `input_flagged` (input guard detected a pattern), `output_flagged` (output guard detected a pattern), `citation_missing` / `citation_hallucinated` (citation guard detected a violation in `warn_and_continue` mode), `provider_retry` (falling back to next provider). Clients should display transiently and clear when the stream ends.
10. **`content_reset`** — emitted when the provider fallback activates mid-stream. Carries `reason: 'provider_fallback'`. **Clients must discard all buffered `content` deltas** received before this event and start accumulating fresh.

## Voice input (transcription)

End-users can dictate messages instead of typing. The chat surfaces (admin `AgentTestChat` and the embed widget) record audio via `MediaRecorder`, POST it to a transcribe endpoint, and put the resulting text into the input field. The chat send path itself is unchanged — voice input produces a regular user message.

**Flow:**

```
mic button click
   → MediaRecorder.start()
   → user speaks
   → mic button click again (or 3-min auto-stop)
   → MediaRecorder.stop()
   → POST audio blob → transcribe endpoint
   → endpoint resolves agent, picks audio provider, calls provider.transcribe()
   → returns { text, durationMs }
   → input field is populated with text
   → user clicks Send (or edits, then sends)
   → standard chat send path (POST /chat/stream)
```

**Endpoints:**

- Admin: `POST /api/v1/admin/orchestration/chat/transcribe` (session auth, multipart). See `.context/api/orchestration-endpoints.md`.
- Embed: `POST /api/v1/embed/speech-to-text` (embed-token auth, multipart). See `.context/api/consumer-chat.md`.

Both gate on `AiAgent.enableVoiceInput && AiOrchestrationSettings.voiceInputGloballyEnabled`. The embed surface additionally requires an audio-capable provider before exposing the mic button — surface in the `voiceInputEnabled` field of `/widget-config`.

**Provider routing:** capability-based via `getAudioProvider()` in `lib/orchestration/llm/provider-manager.ts`. See `.context/orchestration/llm-providers.md` for the routing semantics and `.context/orchestration/meta/architectural-decisions.md` (ADR 3.7a) for why this is separate from `TaskIntent`.

**Audio retention:** none. Bytes flow request → provider → discard; only the transcript is persisted (as a normal user message).

**Cost tracking:** `CostOperation = 'transcription'` rows on `AiCostLog`, priced per-minute (`WHISPER_USD_PER_MINUTE = 0.006`) using `durationMs` reported by the provider. See `.context/orchestration/cost-tracking.md`.

## Image and PDF input

End users can attach images (JPEG/PNG/WebP/GIF) and PDFs to a chat turn. Attachments are sent inline on the standard `POST /chat/stream` body as base64-encoded `ChatAttachment` entries; the streaming-chat path is the same as text-only chat. The attachment data is passed straight to the LLM as `ContentPart[]` parts and discarded — only the agent's text response is persisted.

**Three orthogonal gates run in `streaming-handler.ts` before any provider invocation:**

1. **Per-agent toggle.** `AiAgent.enableImageInput` (images) and `AiAgent.enableDocumentInput` (PDFs). Default off, surfaced as toggles in the admin agent form. Failure emits SSE `IMAGE_DISABLED` / `PDF_DISABLED`.
2. **Org-wide kill switch.** `AiOrchestrationSettings.imageInputGloballyEnabled` and `AiOrchestrationSettings.documentInputGloballyEnabled`. Default on. Failure emits the same `*_DISABLED` codes with a platform-wide message.
3. **Model capability.** `assertModelSupportsAttachments(providerSlug, modelId, kinds)` in `lib/orchestration/llm/provider-manager.ts` checks `AiProviderModel.capabilities` for `'vision'` (image input) and/or `'documents'` (native PDF input). Throws `CAPABILITY_NOT_SUPPORTED`, mapped to `IMAGE_NOT_SUPPORTED` / `PDF_NOT_SUPPORTED` SSE events with copy referencing model selection. Distinct from `'image'` (image generation, storage-only).

The route layer adds two more guards in front of the handler:

- **Rate limit.** `imageLimiter` (20 req/min) keyed `image:user:${userId}` for both admin and consumer routes. Shared bucket across surfaces so a single user cannot abuse images by switching admin/consumer/embed.
- **Magic-byte validation.** `validateImageMagicBytes()` (from `lib/storage/image.ts`) for `image/*` and `validatePdfMagicBytes()` for `application/pdf`. Mismatch returns 415 `IMAGE_INVALID_TYPE` before reaching the orchestration handler.

**Validation caps** (in `lib/validations/orchestration.ts`): per-attachment ≤ `MAX_CHAT_ATTACHMENT_BASE64_CHARS = 7_500_000` (~5 MB binary, Anthropic-safe); per-turn combined ≤ `MAX_CHAT_ATTACHMENT_COMBINED_BASE64_CHARS = 37_500_000` (~25 MB); max 10 attachments per turn. Combined cap enforced by `chatAttachmentsArraySchema.superRefine`.

**Capability seeding.** Capability assignment lives on `AiProviderModel.capabilities` and is admin-curated. The 009-provider-models seed assigns `'vision'` to multimodal chat models across the seeded provider catalogue, and `'documents'` to the rows whose upstream provider accepts inline PDF input today — currently Anthropic Claude 4.x (native `document` block), OpenAI GPT-4o family + GPT-4.1 + GPT-5 (Chat Completions `file` content part, since late 2024), Azure GPT-4o (mirrors OpenAI), Bedrock Claude, and OpenRouter (best-effort — passes through to whichever upstream the auto-router picks). Gemini, Grok, Mistral and the other OpenAI-compatible hosts remain off until their adapters accept the relevant wire format. Operators can add or remove the capability per row from the matrix. Models without the required capability are rejected at the gate with `IMAGE_NOT_SUPPORTED` / `PDF_NOT_SUPPORTED` rather than silently dropped, so end-users get a clear "switch the model" prompt instead of an assistant that pretends to have read the attachment.

**Form-level constraint (Phase 6).** The agent form's image and document toggles in the Model tab are disabled when the currently-selected model lacks the corresponding capability. The toggle's saved value is preserved across model swaps — switching back to a compatible model restores the operator's previous intent. Models that aren't in the provider-models matrix (registry-only entries) fall through to "enabled" so operators aren't locked out of working configurations the matrix hasn't been told about. The runtime gate is still the authoritative check.

**Attachment retention:** none. Bytes flow request → provider → discard; only the user's text becomes a persisted `AiMessage`.

**Cost tracking:** `CostOperation = 'vision'` rows on `AiCostLog`, flat per-attachment via `calculateAttachmentCost(imageCount, pdfCount)` — `IMAGE_USD_PER_IMAGE = 0.001275` and `PDF_USD_PER_PDF = 0.005`. Per-modality counts stamped into the row's metadata. One row per turn, fired right after the user message persists (before any LLM call) since the platform overhead is per-attachment, not per-completion. Per-token chat cost still rolls up under separate `chat` rows on the same conversation.

## Citations

When the LLM grounds a response in retrieved knowledge, the handler accumulates a turn-level citations envelope and surfaces it through three channels:

1. **The LLM** sees a `marker: number` field on each tool-result item it consumes. The tool description instructs the model to cite via `[N]` syntax (e.g. `"the deposit must be protected within 30 days [1]"`). Markers are monotonic across the entire turn — if `search_knowledge_base` is called twice, the second call's markers continue from the first call's last value.
2. **The SSE client** receives a `citations` event with the typed `Citation[]` envelope. Each entry carries `marker`, `chunkId`, `documentId`, `documentName`, `section`, `excerpt`, `similarity`, optional `patternNumber` / `patternName`, and the hybrid scores (`vectorScore`, `keywordScore`, `finalScore`) when running in hybrid search mode.
3. **The persisted assistant message** carries the same envelope on `metadata.citations` so the trace viewer can render the citation panel post-hoc.

Currently `search_knowledge_base` is the only citation-producing capability; the registry list lives in `lib/orchestration/chat/citations.ts#CITATION_PRODUCING_SLUGS`. Adding a new capability to the set is a one-line change once its result envelope matches the expected shape.

Citations are attached only to the **terminal** assistant message (the one that contains the `[N]` markers). Interim tool-call turns do not carry citations because the LLM has not yet produced grounded text.

## Inline trace annotations (admin only)

Internal admin chat surfaces — the Learning Lab pattern advisor and quiz, the agent test tab on the agent edit form, the evaluation runner — display _why_ a response was produced: which capabilities the model invoked, with what arguments, at what latency, and whether each call succeeded. The diagnostic strip renders under each assistant bubble (small grey text, collapsible to per-tool cards) and is also rehydrated post-hoc by the conversation trace viewer.

**Opting in.** The chat request takes a new `includeTrace?: boolean` flag (`ChatRequest` in `lib/orchestration/chat/types.ts`). Default `false`. The admin streaming route — `app/api/v1/admin/orchestration/chat/stream/route.ts` — forwards the client's choice. Consumer routes (`/api/v1/chat/stream`, `/api/v1/embed/chat/stream`) never set the flag, so consumer event payloads keep their existing shape.

**Event shape additions** (additive — old clients ignore them):

```ts
| {
    type: 'capability_result';
    capabilitySlug: string;
    result: unknown;
    trace?: ToolCallTrace; // present iff includeTrace was set
  }
| {
    type: 'capability_results';
    results: Array<{ capabilitySlug: string; result: unknown; trace?: ToolCallTrace }>;
  }
```

`ToolCallTrace` (defined in `types/orchestration.ts`):

| Field           | Source                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `slug`          | Capability slug, e.g. `search_knowledge_base`                                                     |
| `arguments`     | Validated args passed to `capabilityDispatcher.dispatch`                                          |
| `latencyMs`     | `Date.now() - dispatchStart` (per-call for the single branch, batch-wide for the parallel branch) |
| `success`       | Derived from `CapabilityResult.success`                                                           |
| `errorCode`     | `CapabilityResult.error.code` when present                                                        |
| `resultPreview` | First ~480 chars of `JSON.stringify(result)` — keeps the persisted JSON column compact            |

**Persistence.** When `includeTrace: true`, the streaming handler also writes the accumulated `ToolCallTrace[]` onto the _terminal_ assistant message's `metadata.toolCalls`. The conversation trace viewer reads this through `messageMetadataSchema` and renders the same `<MessageTrace>` component used live. Pre-trace conversations have no `toolCalls` field and the strip is simply absent — no migration required.

**Wire-format guarantee.** The consumer route does not thread `includeTrace` into `streamChat`, even if a client sets the flag in its POST body. A regression test in `tests/unit/app/api/v1/chat/stream/route.test.ts` locks this in: a body with `includeTrace: true` must result in `streamChat()` being called without that field. If you add a new consumer-facing chat surface, follow the same pattern — leave the flag unset.

**Client integration.** The shared admin parser (`components/admin/orchestration/chat/chat-events.ts`) validates every SSE block through a discriminated-union Zod schema so the new `trace` field arrives strongly typed. UI consumers should never reach into `parseSseBlock`'s `data: Record<string, unknown>` for trace fields; route them through `parseChatStreamEvent()` instead.

## In-chat approvals

When an agent calls the `run_workflow` capability and the workflow pauses on a `human_approval` step, the chat handler surfaces the pause inline so the end user can Approve or Reject without leaving the conversation.

Sequence on a paused workflow:

```
start → content* → status (Executing run_workflow) → capability_result
      → approval_required → done
```

1. The `run_workflow` capability returns `{ status: 'pending_approval', executionId, stepId, prompt, expiresAt, approveToken, rejectToken }` with `skipFollowup: true`.
2. The streaming handler emits a new `approval_required` ChatEvent carrying the same `PendingApproval` payload (`types/orchestration.ts:PendingApproval`).
3. A synthetic empty-content assistant message is persisted with `metadata.pendingApproval` set on the `AiMessage` row. **Note:** today's `<ChatInterface>` and the embed widget do NOT load conversation history on mount, so a hard reload of the chat loses the card even though the marker persists in the DB. The persistence is in place for future history-load paths, audit (the trace viewer renders the metadata raw), and the admin conversations detail view. Closing the gap is a separate piece of work.
4. `done` fires with the partial-turn cost. **No LLM follow-up turn races the user click** — the next turn is initiated by the user submitting a follow-up message.

The chat surface (admin chat or embed widget) renders an Approve / Reject card from the event and POSTs to the channel-specific public endpoint with the matching token:

| Surface       | Approve URL                                         | Reject URL       | `actorLabel`     |
| ------------- | --------------------------------------------------- | ---------------- | ---------------- |
| Email / Slack | `/api/v1/orchestration/approvals/:id/approve`       | `…/reject`       | `token:external` |
| Admin chat    | `/api/v1/orchestration/approvals/:id/approve/chat`  | `…/reject/chat`  | `token:chat`     |
| Embed widget  | `/api/v1/orchestration/approvals/:id/approve/embed` | `…/reject/embed` | `token:embed`    |

The `actorLabel` is **server-set** by the route hit, never trusted from a body field. CORS is per-channel: same-origin only for `/chat`, allowlist (orchestration setting `embedAllowedOrigins`) for `/embed`, none for the legacy email/Slack route.

After a successful POST, the card polls `GET /api/v1/orchestration/approvals/:id/status?token=…` (token-authenticated, permissive CORS) until the execution reaches a terminal state, then submits a synthesised follow-up message such as `"Workflow approved. Result: { ... }"` so the LLM gets a fresh turn carrying the workflow output.

The chat / embed approve routes fire-and-forget call `resumeApprovedExecution` after the approval action succeeds, so the engine starts draining the resumed run immediately rather than waiting for the maintenance tick (~2 minute stale threshold). Without this, the chat card's 5-minute polling budget would often expire before the workflow had even started resuming. Rejection skips this — there's no further engine work to do.

For approval-only workflows (a single `human_approval` step), the synthesised follow-up's "result" is the approval payload (`{ approved, notes, actor }`) rather than meaningful business data, since that's the workflow's only step output. Multi-step workflows where the last step is an external call or transformation surface that step's output instead. Output is capped at 8000 characters in the synthesised follow-up — workflows that emit larger payloads (full datasets, file blobs) get a `[truncated; N chars total]` stub the LLM can ask the user about.

**Empty-content assistant messages and the LLM context.** The synthetic message persists with `content: ''` so the chat UI can mount the `<ApprovalCard>` without rendering a redundant text bubble. Anthropic's Messages API rejects empty content blocks, so `buildMessages` (`lib/orchestration/chat/message-builder.ts`) filters out empty-content assistant rows when constructing the LLM history for the next turn. Without that filter, the user's follow-up message would fail with a 400 from the provider.

**Surfaces.** `<ChatInterface>` (the message-thread component used by setup-wizard, learn) renders the card inline with a synthesised follow-up via `sendFollowupWhenIdle`, which defers the send when another chat turn is mid-flight (otherwise `sendMessage`'s `if (streaming) return` guard would silently drop it). `<AgentTestChat>` (the single-turn component on the agent edit page Test tab and setup wizard's Test step) also mounts the card but resolves to a static notice — there's no message thread to carry the workflow output back into, so the admin sends a fresh message manually after approving. The embed widget mirrors `<ChatInterface>`'s queued-followup behaviour using its own `sending` flag.

**Carry-the-output-back, not resume-the-stream.** The chat handler is structured around one user message → one assistant reply (with tool-call iterations); re-entering it from a non-chat path would require a per-conversation pub/sub layer that doesn't exist. The polled-then-follow-up flow uses primitives that already exist and the `approval_required` event contract is forward-compatible if a future server-pushed implementation is added.

The [output guard](./output-guard.md) ships an opt-in `citationGuardMode` that flags two failure modes: under-citation (citations were retrieved but no marker appears in the response) and hallucinated markers (a marker referenced that no citation produced).

## Tool Loop Semantics

The tool loop is a bounded while-loop (`MAX_TOOL_ITERATIONS = 5`). Each iteration:

1. Calls `provider.chatStream(messages, options)` with `tools` populated from `getCapabilityDefinitions(agentId)`.
2. Drains the entire stream, capturing `assistantText`, all `tool_call` chunks, and the trailing `usage` from the `done` chunk.
3. Persists the assistant row (skipped when the turn was pure tool-use with no text).
4. **Output guard** — if no tool calls, scans the assistant text via `scanOutput()` before logging cost. If the guard blocks (mode = `block`), the cost is never logged and the stream terminates. See [Output Guard](./output-guard.md).
5. Fires `logCost` once per turn with `operation: CostOperation.CHAT`. Capability costs are logged separately by the dispatcher — there is no double counting.
6. If no tool call: yields `done` and returns.
7. If tool calls: **re-checks budget** via `checkBudget(agentId)` before dispatching — prevents multi-tool conversations from exceeding budget mid-stream. Then dispatches via `capabilityDispatcher.dispatch` (wrapped in a 30-second timeout — see below), yields `capability_result`, persists `role: 'tool'` rows, invalidates the locked context if one is bound, and either returns (on `skipFollowup`) or loops.

Hitting the cap emits `{ type: 'error', code: 'tool_loop_cap' }` and logs a warn.

### Tool dispatch timeout

Every `capabilityDispatcher.dispatch()` call is wrapped in `withToolTimeout()` (default `TOOL_DISPATCH_TIMEOUT_MS = 30_000`). If a tool hangs beyond 30 seconds, the promise rejects with a timeout error, and the LLM receives a `{ success: false, error: 'Tool execution timed out' }` result.

### Tool error backoff

The handler tracks per-tool consecutive failure counts in a `Map<string, number>`. After a tool fails **2 consecutive times** (`TOOL_FAILURE_THRESHOLD`), subsequent requests for that tool are **skipped** — the LLM receives a `{ success: false, error: { code: 'tool_unavailable', message: '...' } }` result without dispatching. This prevents a broken tool from burning through all iterations. Success resets the counter.

### Multiple tool calls

Multiple tool calls in a single LLM turn are dispatched in parallel via `Promise.allSettled`. Each result is persisted individually. The backoff threshold applies per-tool — a failing tool in a multi-call turn doesn't block other tools.

## Context Builder

`buildContext(type, id)` returns a `LOCKED CONTEXT` text block that gets spliced in as a second `system` message after the agent's stable instructions (KV-cache friendly — the instructions prefix is invariant across turns).

```
=== LOCKED CONTEXT ===
type: pattern
id: 1

Pattern #1: ReAct

## overview
Reasoning plus acting is a reflex loop.

## details
...

=== END LOCKED CONTEXT ===
```

**Supported types:** only `pattern` in Phase 2c (delegates to `getPatternDetail`). Other types log a warn and return a benign "no loader" placeholder so the model doesn't hallucinate. Adding types is a ~10-line change — add a `case` in the switch.

**Cache:** plain `Map<string, { value, expiresAt }>` with a 60 s TTL per `(type, id)` pair. Matches the dispatcher's pattern — no shared TTL utility is introduced.

**Invalidation:** `invalidateContext(type, id)` drops a single entry. The streaming handler calls this after every tool dispatch when a context is bound, so a future mutating capability (e.g. `update_pattern`) triggers a re-fetch on the next turn. Phase 2c ships no mutating capabilities, but the hook is wired so later slices don't need to retrofit.

## Rolling Conversation Summary

When conversation history exceeds `MAX_HISTORY_MESSAGES` (50), the streaming handler generates a concise LLM summary of the dropped messages instead of silently truncating them. This preserves the original problem, key decisions, and important context across long conversations.

**How it works:**

1. After loading history, if `history.length > MAX_HISTORY_MESSAGES`, the handler checks whether a persisted summary exists on `AiConversation.summary` and whether it's stale (via `summaryUpToMessageId`).
2. If stale or missing: yields a `{ type: 'status', message: 'Summarizing conversation history...' }` event, calls `summarizeMessages()` on the dropped portion, and persists the result.
3. The summary is passed to `buildMessages()` which emits it as a `[Conversation summary of N earlier messages]` system message instead of the old `[... N older messages omitted ...]` marker.

**Budget:** Uses the `routing` task-type model (budget-tier, e.g. Haiku) via `getDefaultModelForTask('routing')`. Cost is logged as a `CHAT` operation with `agentId: 'system'`.

**Failure:** If summarization fails (provider down, LLM error), the handler falls back to the old truncation marker. Summarization never blocks the main chat flow.

**Staleness:** A summary is considered stale when `summaryUpToMessageId` is null or messages exist beyond that point in the dropped window. Once generated, the summary is reused until new messages push past the window again.

## User Memory

Per-user-per-agent persistent memory that survives across conversations. Stored in the `AiUserMemory` model as key-value pairs scoped to `(userId, agentId)`.

**How it works:**

1. Before building the message array, the handler loads all memories for `(request.userId, agent.id)` from `AiUserMemory`, ordered by `updatedAt DESC`, capped at 50 entries.
2. If memories exist, they're injected as a `[User memories]` system message after the context block but before conversation history. Format: `- key: value` per entry.
3. Agents read/write memories via two built-in capabilities: `read_user_memory` and `write_user_memory`.

**Capabilities:**

| Capability          | Parameters                     | Behavior                                                           |
| ------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `read_user_memory`  | `key?: string`                 | Returns all memories (or single by key) for the current user+agent |
| `write_user_memory` | `key: string`, `value: string` | Upserts a memory — creates if new, updates if existing             |

**Schema:** `AiUserMemory` has a compound unique `(userId, agentId, key)`. Keys are limited to 255 chars, values to 5000 chars.

## Input Guard Modes

The input guard (`scanForInjection`) behavior is now configurable via `OrchestrationSettings.inputGuardMode`:

| Mode                 | Behavior on flagged input                                                  |
| -------------------- | -------------------------------------------------------------------------- |
| `log_only` (default) | Logs the detection, continues processing                                   |
| `warn_and_continue`  | Logs + yields `{ type: 'warning', code: 'input_flagged' }` event to client |
| `block`              | Yields `{ type: 'error', code: 'input_blocked' }` and stops processing     |

In all modes, unflagged input proceeds normally. The mode is read from the cached settings singleton (30s TTL), so changes via PATCH `/settings` take effect within 30 seconds.

## Error Codes

Every terminal `error` event carries one of these stable `code` values:

| Code                     | Source                                                            | Meaning                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent_not_found`        | `loadAgent` — no active `AiAgent` with that slug                  | Resolve the slug or activate the agent                                                                                   |
| `conversation_not_found` | Supplied `conversationId` doesn't match userId/agentId/isActive   | Caller sent a stale or cross-user conversation id                                                                        |
| `budget_exceeded`        | `checkBudget` returns `withinBudget: false` (initial or mid-loop) | Agent has spent more than `monthlyBudgetUsd` this calendar month                                                         |
| `output_blocked`         | Output guard in `block` mode flagged the response                 | Admin has configured strict output filtering — response rejected by content policy                                       |
| `tool_loop_cap`          | Tool loop exhausted `MAX_TOOL_ITERATIONS`                         | A confused model or broken capability is spinning                                                                        |
| `input_blocked`          | Input guard in `block` mode flagged the message                   | Admin has configured strict input filtering — message rejected by security policy                                        |
| `internal_error`         | Any other thrown exception                                        | Provider failure, DB outage, etc. `message` is a **generic** sanitized string — the raw error is logged server-side only |

Dispatcher-level failures (`unknown_capability`, `rate_limited`, `requires_approval`, `invalid_args`, `execution_error`) surface as `capability_result` events with `success: false` — they're not fatal to the chat turn. The LLM sees them as tool errors unless `skipFollowup` is set.

## OTEL tracing

The chat turn is wrapped in a top-level `chat.turn` span; each pass through the streaming retry loop opens an `llm.call` child span. Mid-stream provider failover is recorded as an exception + `sunrise.provider.failover_from` / `sunrise.provider.failover_to` attributes on the failed span; the retry attempt opens a fresh `llm.call` sibling. Capability dispatches automatically attach as children of the active `llm.call` via the dispatcher's internal wrap.

Span status follows OTEL conventions: `error` for caught exceptions (provider error, internal error, `ChatError`); `ok` for in-try error events (budget exceeded, output guard block, conversation cap) — application-level outcomes equivalent to HTTP 4xx, not transport failures.

See [`tracing.md`](tracing.md) for the full guide.

## Supporting modules

Three internal modules under `lib/orchestration/chat/` are not exported from the barrel but are core to the handler. Documented here so they aren't invisible to future readers.

### `summarizer.ts` — rolling history summary

- Primary export: `summarizeMessages(messages, providerSlug, fallbackSlugs)` returning a string.
- Called by the handler from the [Rolling Conversation Summary](#rolling-conversation-summary) flow once `history.length > MAX_HISTORY_MESSAGES`.
- Runs on the **`routing` task-type model** (budget tier, e.g. Haiku) resolved via `getDefaultModelForTask('routing')` in the LLM settings resolver. Capped at `maxTokens: 500`.
- Logs cost as a `CostOperation.CHAT` row with `agentId: 'system'` and `conversationId: 'summary'`.
- **Never throws.** Any failure (provider down, LLM error, empty response) returns `FALLBACK_MESSAGE = '[Summary unavailable — earlier messages omitted]'` so the chat turn keeps moving.
- Prompt is a fixed system message telling the model to produce a third-person summary covering the original problem, key decisions, facts/constraints, and current state.

### `token-estimator.ts` — context window sizing

- `estimateTokens(text, modelId?)` — when `modelId` is supplied (production path), delegates to `tokeniserForModel(modelId)` from `lib/orchestration/llm/tokeniser.ts` — exact for OpenAI, calibrated approximators for Anthropic / Gemini / Llama. Without `modelId`, falls back to a `chars / 3.5 + 4` heuristic.
- `estimateMessagesTokens(messages, modelId?)` — sum of `estimateTokens` across every message's extracted text content.
- `truncateToTokenBudget(history, maxTokens, modelId?)` — drops messages from the **front** of the array (oldest first) until the remainder fits. Always keeps at least one entry. Returns `{ messages, droppedCount }`.
- Estimates are deliberately **conservative** — better to truncate early than blow past the provider's context window. Per-provider routing and calibration multipliers are documented in [`llm-providers.md` → Tokenisation](./llm-providers.md#tokenisation).

### `message-embedder.ts` — async embedding for semantic search

- `queueMessageEmbedding(messageId, content)` — fire-and-forget. Called after writing an assistant `AiMessage` row; returns immediately and runs the actual embed on a detached promise. Failures are logged but never surfaced to the chat stream. Messages shorter than 20 chars are skipped.
- `backfillMissingEmbeddings(batchSize = 25)` — called from the unified maintenance tick (see [`scheduling.md`](./scheduling.md#unified-maintenance-tick-admin-auth-required-preferred)). Finds assistant messages without a matching `AiMessageEmbedding` row (via `LEFT JOIN`) and re-embeds up to `batchSize` entries per invocation.
- Internally `generateAndStoreEmbedding` truncates content above 8000 chars (cost control) and upserts through a raw `INSERT ... ON CONFLICT` so double-invocations are idempotent.
- Powers `POST /conversations/search` (pgvector semantic search) — without the embedder those endpoints return empty results. See [`orchestration-conversations.md`](../admin/orchestration-conversations.md).

## HTTP Surface

Session 3.3 shipped the admin SSE route at `app/api/v1/admin/orchestration/chat/stream/route.ts`. It's a thin wrapper — roughly:

```typescript
import { sseResponse } from '@/lib/api/sse';
import { streamChat } from '@/lib/orchestration/chat';

export const POST = withAdminAuth(async (request, session) => {
  const body = await validateRequestBody(request, chatStreamRequestSchema);
  const events = streamChat({ ...body, userId: session.user.id, signal: request.signal });
  return sseResponse(events, { signal: request.signal });
});
```

Full request/response contract, curl examples, and a browser JS client example live in [`admin-api.md`](./admin-api.md#chat-streaming). The SSE bridge itself is documented in [`../api/sse.md`](../api/sse.md).

### Error sanitization — hard guarantee

The catch-all `internal_error` event **no longer forwards `err.message`**. Before Session 3.3 this was a live information leak: Prisma connection strings, provider SDK errors, and internal hostnames flowed straight to the client. The fix in `lib/orchestration/chat/streaming-handler.ts`:

```typescript
// Do NOT forward raw err.message — it can leak Prisma internals,
// provider SDK details, and internal hostnames to the client. The
// detailed error has already been logged via logger.error above.
yield errorEvent('internal_error', 'An unexpected error occurred');
```

Detailed errors are logged server-side via `logger.error` immediately before the yield (`streaming-handler.ts` — search for the catch-all around the end of `run()`). That's the only place to debug a specific `internal_error` — the client gets the generic string, the server gets the full error context.

The SSE bridge in `lib/api/sse.ts` has a second sanitization layer for the pathological case where the iterator itself throws (rather than yielding a domain `error` event): it emits a generic `{ code: 'stream_error', message: 'Stream terminated unexpectedly' }` frame and closes. Belt and braces — neither layer ever leaks raw error text.

Typed domain errors (`ChatError` — `agent_not_found`, `conversation_not_found`, `budget_exceeded`, `tool_loop_cap`) still pass through with their original stable codes and messages because they're yielded as events, not thrown.

## Anti-Patterns

**Don't** wrap the handler in SSE framing inside `lib/orchestration/chat/`. That's the route layer's job:

```typescript
// Bad — couples the handler to Next.js
import { NextResponse } from 'next/server';
export async function* badHandler() {
  yield new NextResponse('data: ...\n\n');
}
```

**Don't** call `providerManager.getProvider` or `capabilityDispatcher.dispatch` from agent-facing code paths. Use `streamChat` — it wires budgets, cost logging, and message persistence correctly.

**Don't** skip `registerBuiltInCapabilities()`. `streamChat` calls it at the top of every turn (idempotent), so new test harnesses and CLI callers get the right handler map without thinking about it.

**Don't** emit your own `CostOperation.CHAT` log rows from capability code. The chat handler owns per-turn chat costs; capabilities log their own `tool_call` rows via the dispatcher.

**Don't** import `next/*` anywhere under `lib/orchestration/chat/`:

```typescript
// Will break the platform-agnostic contract
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
```

**Don't** persist custom message shapes — stick with the four `AiMessage.role` values (`user`, `assistant`, `system`, `tool`). `buildMessages` normalises unknown roles to `user` with a warn so a corrupt row can't crash the provider, but that's a safety net, not a design pattern.

## Testing

Unit tests live in `tests/unit/lib/orchestration/chat/`. Mocking style matches the rest of the orchestration domain:

```typescript
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
    aiConversation: { findFirst: vi.fn(), create: vi.fn() },
    aiMessage: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  checkBudget: vi.fn(),
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.03 /* ... */ })),
  logCost: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities/registry', () => ({
  registerBuiltInCapabilities: vi.fn(),
  getCapabilityDefinitions: vi.fn().mockResolvedValue([]),
}));

const { streamChat } = await import('@/lib/orchestration/chat/streaming-handler');
```

Notes:

- Build a mock `LlmProvider` whose `chatStream` yields a different scripted `StreamChunk[]` per turn (see `tests/unit/lib/orchestration/chat/streaming-handler.test.ts`). This lets a single test script a full tool round-trip.
- For assertions on the fire-and-forget `logCost`, flush microtasks (`await Promise.resolve(); await Promise.resolve();`) before inspecting the mock.
- Drain each stream with a tiny `collect()` helper rather than manual `for await` — it makes assertions on the full event sequence much cleaner.
- Don't mock `@/lib/orchestration/chat/message-builder` — it's pure and fast.

Run the suite:

```bash
npx vitest run tests/unit/lib/orchestration/chat
```

## Smoke Testing

`scripts/smoke/chat.ts` exercises `streamChat` end-to-end against the real dev Postgres database, with a fake `LlmProvider` injected via `registerProviderInstance` (no API key, no SDK, no network). It verifies the full event sequence, the persisted `AiMessage` rows, and the fire-and-forget `AiCostLog` row actually land.

```bash
npm run smoke:chat
```

Run this whenever you touch `streaming-handler.ts`, `provider-manager.ts`, or the `AiConversation`/`AiMessage`/`AiCostLog` schema — unit tests mock Prisma, so a broken FK chain or import binding can slip through vitest but not the smoke script. See [`scripts/smoke/README.md`](../../scripts/smoke/README.md) for safety rules and the template to follow when adding more smoke scripts.

## Context Window Management

The message builder supports token-aware truncation to prevent exceeding model context limits. Configured via `contextWindowTokens` and `reserveTokens` on `BuildMessagesArgs`.

**How it works:**

1. System prompt, user message, and history are assembled
2. If `contextWindowTokens` is set, the builder calculates a token budget: `contextWindowTokens - reserveTokens - systemTokens - userTokens - attachmentTokens` (where `attachmentTokens = attachments.length × ATTACHMENT_OVERHEAD_TOKENS`)
3. `truncateToTokenBudget()` drops the oldest history messages until the remaining messages fit the budget
4. At least one history message is always kept

Token estimation is **per-provider tokeniser-aware** — the streaming handler passes the agent's `model` into `buildMessages()`, which routes to `tokeniserForModel(modelId)`. OpenAI models get exact counts via `gpt-tokenizer` (`o200k_base` / `cl100k_base`); Anthropic, Gemini, and Llama-family get calibrated approximators that overestimate by 5–10% for safety. See [`llm-providers.md` → Tokenisation](./llm-providers.md#tokenisation).

When `contextWindowTokens` is not set, the handler falls back to the fixed `MAX_HISTORY_MESSAGES = 50` limit.

**Key files:** `lib/orchestration/chat/token-estimator.ts`, `lib/orchestration/chat/message-builder.ts`

## Mid-Stream Retry & Recovery

If the LLM stream fails mid-response (network error, provider outage), the handler automatically retries with the next fallback provider:

1. On stream failure, the handler records a circuit breaker failure for the current provider
2. If the error is an `AbortError` (client disconnect), it throws immediately — no retry
3. Otherwise, it shifts the next slug from `remainingFallbacks` and emits a `{ type: 'warning', code: 'provider_retry' }` SSE event
4. A `{ type: 'content_reset', reason: 'provider_fallback' }` event is yielded — **clients must discard any buffered `content` deltas** received before this event
5. Accumulated content and tool calls are reset, and the stream restarts from the new provider
6. After `MAX_STREAM_RETRIES` (2) attempts or no more fallbacks, the error propagates

This differs from the initial provider fallback (`getProviderWithFallbacks`) which only selects the starting provider based on circuit breaker state. Mid-stream retry handles failures that occur after the stream has started producing chunks.

### Orphaned Message Prevention

When all providers fail (error propagates to the outer catch), an **error-marker assistant message** is persisted to prevent an orphaned user message in the conversation:

- `role: 'assistant'`, `content: '[An error occurred and the response could not be completed.]'`
- `metadata: { error: true, errorCode: 'internal_error' }`
- Only persisted when `conversationId` is set (i.e. the conversation was created before the failure)
- Persist failure is caught and logged — it never masks the original error

## Conversation and Message Caps

Configurable limits prevent unbounded storage growth. Both are read from `AiOrchestrationSettings` (singleton, `slug = 'global'`):

| Setting                      | Enforced where                     | Error code                        |
| ---------------------------- | ---------------------------------- | --------------------------------- |
| `maxConversationsPerUser`    | Before creating a new conversation | `conversation_cap_reached`        |
| `maxMessagesPerConversation` | After loading history, before send | `conversation_length_cap_reached` |

- `null` (default) means unlimited — no cap is enforced.
- Conversation cap counts active conversations for the same user + agent pair.
- Message cap uses `prisma.aiMessage.count()` against the limit (not `history.length`, which is capped at 200).
- Both throw `ChatError` so the client receives a typed `{ type: 'error', code, message }` SSE event.

## Error Handling & Resilience

See [Resilience](./resilience.md) for full details. Key points for the chat handler:

- **Provider fallback**: `getProviderWithFallbacks()` checks circuit breakers and falls back through `agent.fallbackProviders` before throwing `all_providers_exhausted`.
- **Mid-stream retry**: if a stream fails after starting, automatically retries with the next fallback provider (up to 2 retries). Emits `provider_retry` warning event.
- **Circuit breaker**: `getBreaker(slug).recordSuccess()` / `.recordFailure()` called after each LLM turn.
- **Budget warning**: at 80% usage, yields `{ type: 'warning', code: 'budget_warning' }` before continuing.
- **Input guard**: `scanForInjection(message)` runs on every user message. If the score exceeds the configured threshold, yields `{ type: 'error', code: 'input_blocked' }` and aborts the stream. Below-threshold matches are logged as warnings.
- **Error sanitization**: the catch-all yields `{ type: 'error', code: 'internal_error', message: 'An unexpected error occurred' }` — raw provider/SDK errors are logged server-side only via `logger.error`.

## Related Documentation

- [Orchestration Overview](./overview.md) — domain entry point
- [LLM Providers](./llm-providers.md) — the Phase 2a provider abstraction the handler streams from
- [Capabilities](./capabilities.md) — the Phase 2b dispatcher the handler invokes on tool calls
- [Resilience](./resilience.md) — circuit breaker, fallback, budget UX, input guard
- `.claude/docs/agent-orchestration.md` — architectural brief
- `types/orchestration.ts` — `ChatEvent`, `TokenUsage`, `CostOperation`, `AgentWithCapabilities`
- `prisma/schema.prisma` — `AiAgent`, `AiConversation`, `AiMessage`
