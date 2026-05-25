/**
 * drainStreamChat — utility to consume a `streamChat` async iterable to
 * completion and return a typed summary of what was emitted.
 *
 * Used by:
 *   - `run-cases/agent-case.ts` — drains the subject agent (case →
 *     assistant turn).
 *   - The `judge_agent` grader — drains a judge agent and parses its
 *     final assistant turn as a `{ score, reasoning }` JSON envelope.
 *
 * Centralising this loop means there's exactly one place that decides
 * how a ChatEvent stream maps to a final result — no drift between the
 * two callers.
 */

import type { ChatEvent, Citation, ToolCallTrace } from '@/types/orchestration';
import type { ChatRequest } from '@/lib/orchestration/chat/types';
import { streamChat } from '@/lib/orchestration/chat/streaming-handler';

export interface DrainResult {
  /** Concatenated `content` deltas — the full assistant message text. */
  assistantText: string;
  citations: Citation[];
  toolCalls: ToolCallTrace[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
  latencyMs: number;
  /** Set when the stream ended with a `{ type: 'error' }` event. */
  errorCode?: string;
  errorMessage?: string;
  /** Conversation id surfaced by the stream — useful for cross-referencing. */
  conversationId?: string;
  /** Final assistant message id (set on the `done`/`start` events). */
  messageId?: string;
}

/**
 * Consume a streamChat invocation to completion. Never throws on stream
 * `error` events — they're folded into the result as `errorCode` +
 * `errorMessage` so callers can decide per-context whether to surface
 * them or treat the case as "subject failed, grade with null".
 *
 * Genuine infrastructure errors (network failure, etc.) DO throw — the
 * caller catches and writes the case-result row with a stack-traceable
 * error code.
 */
export async function drainStreamChat(request: ChatRequest): Promise<DrainResult> {
  const start = Date.now();
  const stream = streamChat(request) as AsyncIterable<ChatEvent>;

  let assistantText = '';
  let citations: Citation[] = [];
  const toolCalls: ToolCallTrace[] = [];
  let tokenUsage = { input: 0, output: 0 };
  let costUsd = 0;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let conversationId: string | undefined;
  let messageId: string | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case 'start':
        conversationId = event.conversationId;
        messageId = event.messageId;
        break;
      case 'content':
        assistantText += event.delta ?? '';
        break;
      case 'capability_result':
        if (event.trace) toolCalls.push(event.trace);
        break;
      case 'citations':
        if (Array.isArray(event.citations)) citations = event.citations;
        break;
      case 'done':
        tokenUsage = {
          input: event.tokenUsage.inputTokens ?? 0,
          output: event.tokenUsage.outputTokens ?? 0,
        };
        costUsd = event.costUsd;
        break;
      case 'error':
        errorCode = event.code;
        errorMessage = event.message;
        break;
    }
  }

  const result: DrainResult = {
    assistantText,
    citations,
    toolCalls,
    tokenUsage,
    costUsd,
    latencyMs: Date.now() - start,
  };
  if (errorCode) result.errorCode = errorCode;
  if (errorMessage) result.errorMessage = errorMessage;
  if (conversationId) result.conversationId = conversationId;
  if (messageId) result.messageId = messageId;
  return result;
}
