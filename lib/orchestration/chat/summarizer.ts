/**
 * Conversation summarizer
 *
 * When message history exceeds the truncation threshold, this module
 * generates a concise LLM summary of the oldest messages so that
 * early context (original problem, key decisions) is preserved instead
 * of being silently dropped.
 *
 * Uses the `routing` task-type model (budget-tier) to keep costs low.
 * The summary is persisted on the `AiConversation` row so it only
 * needs generating once until new messages push past the window again.
 */

import { logger } from '@/lib/logging';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';
import type { HistoryRow } from './message-builder';

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Given the conversation history below, produce a concise summary that preserves:
- The user's original problem or request
- Key decisions made during the conversation
- Important facts, constraints, or context established
- The current state of the discussion

Be factual and brief. Do not add commentary. Write in third person (e.g. "The user asked about..." / "The assistant explained...").`;

const FALLBACK_MESSAGE = '[Summary unavailable — earlier messages omitted]';

/**
 * Summarize a list of conversation messages using a budget-tier LLM.
 *
 * On failure (provider unavailable, LLM error), returns a fallback
 * string rather than throwing — summarization should never block the
 * main chat flow.
 */
export async function summarizeMessages(
  messages: HistoryRow[],
  providerSlug: string,
  fallbackSlugs: string[]
): Promise<string> {
  if (messages.length === 0) return FALLBACK_MESSAGE;

  try {
    const model = await getDefaultModelForTask('routing');
    const { provider } = await getProviderWithFallbacks(providerSlug, fallbackSlugs);

    const formatted = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');

    const response = await provider.chat(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: formatted },
      ],
      { model, maxTokens: 500 }
    );

    // Fire-and-forget cost log for the summary call
    void logCost({
      agentId: 'system',
      conversationId: 'summary',
      model,
      provider: providerSlug,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      operation: CostOperation.CHAT,
    });

    return response.content.trim() || FALLBACK_MESSAGE;
  } catch (err) {
    logger.warn('Conversation summarization failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    });
    return FALLBACK_MESSAGE;
  }
}
