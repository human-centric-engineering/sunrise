/**
 * Streaming chat handler types
 *
 * Pure types and module-level constants shared by the chat handler.
 * `ChatEvent`, `TokenUsage`, and `CostOperation` live in
 * `@/types/orchestration` — we reuse them, never redefine.
 */

import type { ChatEvent } from '@/types/orchestration';

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
  /** Free-form metadata forwarded into the capability dispatcher. */
  entityContext?: Record<string, unknown>;
  /** Request-scoped correlation ID for structured log tracing. */
  requestId?: string;
  /** Abort mid-stream. Forwarded into LlmOptions.signal. */
  signal?: AbortSignal;
}

/** Return type of `streamChat` and `StreamingChatHandler.run`. */
export type ChatStream = AsyncIterable<ChatEvent>;

/** Hard cap on LLM turns per `streamChat` invocation. Prevents runaway tool chains. */
export const MAX_TOOL_ITERATIONS = 5;

/** Keep this many recent DB messages verbatim; older ones are dropped with a marker. */
export const MAX_HISTORY_MESSAGES = 20;
