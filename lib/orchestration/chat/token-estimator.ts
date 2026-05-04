/**
 * Token estimation utility
 *
 * Provides token counts for context-window management. When a `modelId`
 * is supplied, we delegate to a per-provider tokeniser
 * (`tokeniserForModel`) — exact for OpenAI, calibrated approximations
 * for everyone else. Without a model id we fall back to a coarse
 * `chars / 3.5` heuristic; that path exists only as a defensive
 * fallback for legacy callers — production paths now thread the
 * `modelId` through.
 *
 * The estimates are intentionally conservative — they slightly
 * over-count, which means we'll truncate a bit earlier than necessary
 * rather than exceeding the context window.
 *
 * See `lib/orchestration/llm/tokeniser.ts` for the per-provider
 * routing and calibration multipliers.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';
import { tokeniserForModel } from '@/lib/orchestration/llm/tokeniser';

/** Heuristic: average characters per token for English prose. */
const HEURISTIC_CHARS_PER_TOKEN = 3.5;

/** Overhead tokens per message for role markers, delimiters, etc. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate the token count of a single string.
 *
 * @param text The text to count.
 * @param modelId Optional model id — when supplied, the count is
 *   produced by that model's tokeniser (exact for OpenAI, calibrated
 *   for Anthropic / Google / Llama). Without it, falls back to the
 *   `chars / 3.5` heuristic.
 */
export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  if (modelId) {
    return tokeniserForModel(modelId).count(text) + MESSAGE_OVERHEAD_TOKENS;
  }
  return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Estimate the total token count for an array of LLM messages.
 *
 * **Text-only**: extracts text via `getTextContent()` and silently
 * discards non-text content parts (images, documents). For multimodal
 * messages, callers should add `ATTACHMENT_OVERHEAD_TOKENS` per
 * attachment separately (see `message-builder.ts`).
 */
export function estimateMessagesTokens(messages: LlmMessage[], modelId?: string): number {
  let total = 0;
  for (const msg of messages) {
    const text = getTextContent(msg.content);
    total += estimateTokens(text, modelId);
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
  maxTokens: number,
  modelId?: string
): { messages: LlmMessage[]; droppedCount: number } {
  if (history.length === 0) return { messages: [], droppedCount: 0 };

  // Fast path: everything fits
  const totalTokens = estimateMessagesTokens(history, modelId);
  if (totalTokens <= maxTokens) {
    return { messages: history, droppedCount: 0 };
  }

  // Drop oldest messages until we fit
  let current = totalTokens;
  let dropIndex = 0;
  while (dropIndex < history.length - 1 && current > maxTokens) {
    const text = getTextContent(history[dropIndex].content);
    current -= estimateTokens(text, modelId);
    dropIndex++;
  }

  return {
    messages: history.slice(dropIndex),
    droppedCount: dropIndex,
  };
}
