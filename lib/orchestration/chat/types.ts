/**
 * Streaming chat handler types
 *
 * Pure types and module-level constants shared by the chat handler.
 * `ChatEvent`, `TokenUsage`, and `CostOperation` live in
 * `@/types/orchestration` — we reuse them, never redefine.
 */

import type { ChatEvent } from '@/types/orchestration';

/**
 * A file attachment sent with a chat message. The chat handler
 * converts these to `ContentPart[]` before passing to the LLM.
 */
export interface ChatAttachment {
  /** Original filename (e.g., "screenshot.png"). */
  name: string;
  /** MIME type (e.g., "image/png", "application/pdf"). */
  mediaType: string;
  /** Base64-encoded file content. */
  data: string;
}

/**
 * Input accepted by {@link streamChat} / {@link StreamingChatHandler.run}.
 *
 * `conversationId` is optional — when omitted, the handler creates a new
 * `AiConversation` scoped to `userId` + the resolved agent.
 */
export interface ChatRequest {
  /**
   * The user's message. Optional only when {@link ChatRequest.openingTurn} is
   * set — a turn the agent opens has no user text by definition. One of the two
   * must be present; the handler rejects a request carrying neither.
   */
  message?: string;
  agentSlug: string;
  userId: string;
  conversationId?: string;
  contextType?: string;
  contextId?: string;
  /** File attachments (images, documents) to include with the message. */
  attachments?: ChatAttachment[];
  /** Free-form metadata forwarded into the capability dispatcher. */
  entityContext?: Record<string, unknown>;
  /**
   * Optional free-form scope map threaded verbatim into every
   * capability dispatch (`CapabilityContext.scope`). Generic by design —
   * core names no keys and no core capability reads it. Downstream
   * consumers populate well-known keys (e.g. a module slug) so a
   * capability can refuse to run outside its intended scope. Absent
   * (and inert) in vanilla Sunrise.
   */
  scope?: Record<string, string>;
  /** Request-scoped correlation ID for structured log tracing. */
  requestId?: string;
  /**
   * Durable anonymous visitor ID, propagated from the proxy so the
   * handler's internal log lines correlate to a visitor's journey across
   * requests (not just within this one). Absent for third-party embeds
   * (the SameSite=Lax cookie isn't sent cross-site) and when tracking is
   * disabled. See lib/logging/visitor-id.ts.
   */
  visitorId?: string;
  /** Abort mid-stream. Forwarded into LlmOptions.signal. */
  signal?: AbortSignal;
  /**
   * Admin-only diagnostic opt-in. When `true`, the handler attaches a
   * `trace` field to each `capability_result` event (validated args,
   * latency, success/error) and persists a `toolCalls[]` array on the
   * terminal assistant message metadata. Default `false` — consumer
   * routes leave this unset so tool arguments and internal scores
   * never leak through public chat surfaces.
   */
  includeTrace?: boolean;
  /**
   * Free-form metadata merged into every `AiCostLog.metadata` row this
   * call writes. Used by the evaluation batch worker to tag rows with
   * `{ evaluationRunId, role: 'subject' | 'judge' }` so the empirical
   * cost estimator can join past runs by role. The handler does not
   * inspect these keys — they're a pass-through marker for analytics.
   */
  costLogMetadata?: Record<string, unknown>;
  /**
   * Free-form metadata stored on the `AiMessage` row this turn creates, under
   * `MessageMetadata.app` (#475).
   *
   * Distinct from `costLogMetadata`, which lands on `AiCostLog` — this one is on
   * the message itself, so a consumer reading the transcript can see it. Stored
   * verbatim under a single namespaced key; the handler never inspects it.
   *
   * Use it to record that a turn happened because the *app* did something rather
   * than because the user typed: a scheduled check-in, a replay, an
   * agent-initiated follow-up. Pair it with {@link ChatRequest.openingTurn} to
   * tag a server-composed opener structurally instead of by a sentinel string in
   * the message text.
   *
   * @example { messageMetadata: { synthetic: true, trigger: 'phase-2-opener' } }
   */
  messageMetadata?: Record<string, unknown>;
  /**
   * Run a turn the **agent** opens, with no user message.
   *
   * Normally `message` is required and is persisted as a `role:'user'` row before
   * the model is called. That is right for a support chatbot, and wrong for a
   * facilitated product whose method is to orient the person first — under the
   * old shape the app had to send a stage direction *as the user*, leaving text
   * in someone's own transcript that they did not write, in the model's history
   * for the rest of the conversation, and filterable only by exact string match.
   *
   * With `openingTurn` set, `message` may be omitted. The content is injected as
   * a `system` message (not persisted as `user`), so it steers the opening
   * without appearing as the person's words. See #474.
   *
   * @example { openingTurn: { content: 'Greet them and ask what they want to fix.' } }
   */
  openingTurn?: { content: string };
}

/** Return type of `streamChat` and `StreamingChatHandler.run`. */
export type ChatStream = AsyncIterable<ChatEvent>;

/** Hard cap on LLM turns per `streamChat` invocation. Prevents runaway tool chains. */
export const MAX_TOOL_ITERATIONS = 5;

/**
 * Fallback message count limit when token-based truncation is not active
 * (i.e., no model context window information is available). Also serves
 * as a hard upper-bound on the number of history messages to load from
 * the database, even when token-based truncation is in use.
 */
export const MAX_HISTORY_MESSAGES = 50;

/**
 * How far **past** the current drop boundary a summarisation run extends.
 *
 * The rolling summary covers a prefix of the conversation, and the prefix has
 * to include everything that falls out of the {@link MAX_HISTORY_MESSAGES}
 * window — otherwise messages leave the prompt with nothing standing in for
 * them. That boundary advances by roughly two messages a turn (one user, one
 * assistant), so a summary pinned exactly at it is stale on the very next turn,
 * which is how #654 came to re-summarise every single turn.
 *
 * Summarising this many messages *beyond* the requirement buys reuse: the
 * stored summary stays valid for about `SUMMARY_LOOKAHEAD_MESSAGES / 2` turns,
 * and only then is a fresh call needed. Ten is deliberately modest — the
 * lookahead messages are dropped from the verbatim window as well as being
 * summarised (the summary boundary IS the drop boundary, so nothing is ever in
 * the prompt twice), which means a larger value trades verbatim recall for
 * fewer summariser calls. At 10 the verbatim window sits between
 * `cap - 10` and `cap` messages.
 */
export const SUMMARY_LOOKAHEAD_MESSAGES = 10;

/**
 * Default number of tokens to reserve for the model's response when
 * performing token-aware context window management.
 */
export const DEFAULT_RESERVE_TOKENS = 4096;
