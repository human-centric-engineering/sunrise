/**
 * Token estimation utility
 *
 * Provides fast, approximate token counts for context window management.
 * Uses a character-based heuristic (1 token ≈ 4 characters for English
 * text) which is accurate enough for truncation decisions without
 * requiring a tokenizer dependency.
 *
 * The heuristic is intentionally conservative — it slightly overestimates
 * token counts, which means we'll truncate a bit earlier than necessary
 * rather than exceeding the context window.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';

/** Average characters per token — conservative estimate for English text. */
const CHARS_PER_TOKEN = 3.5;

/** Overhead tokens per message for role markers, delimiters, etc. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate the token count of a single string.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Estimate the total token count for an array of LLM messages.
 *
 * **Text-only**: extracts text via `getTextContent()` and silently
 * discards non-text content parts (images, documents). For multimodal
 * messages, callers should add `ATTACHMENT_OVERHEAD_TOKENS` per
 * attachment separately (see `message-builder.ts`).
 */
export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const text = getTextContent(msg.content);
    total += estimateTokens(text);
  }
  return total;
}

/**
 * Truncate history messages to fit within a token budget.
 *
 * Removes oldest messages first (from the front of the array) until
 * the remaining messages fit within `maxTokens`. Returns an object
 * with the truncated history and the number of messages dropped.
 *
 * Always keeps at least the most recent message to avoid returning
 * an empty history.
 */
export function truncateToTokenBudget(
  history: LlmMessage[],
  maxTokens: number
): { messages: LlmMessage[]; droppedCount: number } {
  if (history.length === 0) return { messages: [], droppedCount: 0 };

  // Fast path: everything fits
  const totalTokens = estimateMessagesTokens(history);
  if (totalTokens <= maxTokens) {
    return { messages: history, droppedCount: 0 };
  }

  // Drop oldest messages until we fit
  let current = totalTokens;
  let dropIndex = 0;
  while (dropIndex < history.length - 1 && current > maxTokens) {
    const text = getTextContent(history[dropIndex].content);
    current -= estimateTokens(text);
    dropIndex++;
  }

  return {
    messages: history.slice(dropIndex),
    droppedCount: dropIndex,
  };
}
