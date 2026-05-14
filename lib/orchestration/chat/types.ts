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
  message: string;
  agentSlug: string;
  userId: string;
  conversationId?: string;
  contextType?: string;
  contextId?: string;
  /** File attachments (images, documents) to include with the message. */
  attachments?: ChatAttachment[];
  /** Free-form metadata forwarded into the capability dispatcher. */
  entityContext?: Record<string, unknown>;
  /** Request-scoped correlation ID for structured log tracing. */
  requestId?: string;
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
 * Default number of tokens to reserve for the model's response when
 * performing token-aware context window management.
 */
export const DEFAULT_RESERVE_TOKENS = 4096;
