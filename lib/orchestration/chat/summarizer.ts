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
import { calculateCost, logCost } from '@/lib/orchestration/llm/cost-tracker';
import { CostOperation } from '@/types/orchestration';
import type { HistoryRow } from '@/lib/orchestration/chat/message-builder';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  SPAN_LLM_CALL,
  setSpanAttributes,
  withSpan,
} from '@/lib/orchestration/tracing';

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Given the conversation history below, produce a concise summary that preserves:
- The user's original problem or request
- Key decisions made during the conversation
- Important facts, constraints, or context established
- The current state of the discussion

Be factual and brief. Do not add commentary. Write in third person (e.g. "The user asked about..." / "The assistant explained...").`;

const FALLBACK_MESSAGE = '[Summary unavailable — earlier messages omitted]';

/**
 * Result of a successful summariser call. Surfaces the model, provider,
 * token usage and computed cost so the chat handler can roll the call
 * into the turn's `sideEffectModels` aggregate. On fallback (LLM error,
 * empty history) `summary` is the placeholder text and the numeric
 * fields are zeroed.
 */
export interface SummarizeResult {
  summary: string;
  /** True when the call returned the placeholder rather than an LLM summary. */
  fellBack: boolean;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Summarize a list of conversation messages using a budget-tier LLM.
 *
 * On failure (provider unavailable, LLM error), returns a fallback
 * string rather than throwing — summarization should never block the
 * main chat flow. The caller is responsible for distinguishing the
 * fallback path via `result.fellBack` if it wants different UX.
 */
export async function summarizeMessages(
  messages: HistoryRow[],
  providerSlug: string,
  fallbackSlugs: string[]
): Promise<SummarizeResult> {
  if (messages.length === 0) {
    return { summary: FALLBACK_MESSAGE, fellBack: true };
  }

  try {
    const model = await getDefaultModelForTask('routing');
    const { provider, usedSlug } = await getProviderWithFallbacks(providerSlug, fallbackSlugs);

    const formatted = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');

    return await withSpan(
      SPAN_LLM_CALL,
      {
        [GEN_AI_OPERATION_NAME]: 'summary',
        [GEN_AI_REQUEST_MODEL]: model,
        [GEN_AI_SYSTEM]: usedSlug,
        [GEN_AI_REQUEST_MAX_TOKENS]: 500,
      },
      async (span) => {
        const response = await provider.chat(
          [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: formatted },
          ],
          { model, maxTokens: 500 }
        );

        setSpanAttributes(span, {
          [GEN_AI_RESPONSE_MODEL]: model,
          [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
          [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage.inputTokens + response.usage.outputTokens,
        });

        // Fire-and-forget cost log for the summary call
        void logCost({
          agentId: 'system',
          conversationId: 'summary',
          model,
          provider: usedSlug,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          operation: CostOperation.CHAT,
          traceId: span.traceId(),
          spanId: span.spanId(),
        });

        const summary = response.content.trim() || FALLBACK_MESSAGE;
        const cost = calculateCost(model, response.usage.inputTokens, response.usage.outputTokens);
        return {
          summary,
          fellBack: summary === FALLBACK_MESSAGE,
          model,
          provider: usedSlug,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costUsd: cost.totalCostUsd,
        };
      }
    );
  } catch (err) {
    logger.warn('Conversation summarization failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    });
    return { summary: FALLBACK_MESSAGE, fellBack: true };
  }
}
