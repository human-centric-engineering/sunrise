/**
 * Conversation summarizer
 *
 * When message history exceeds the truncation threshold, this module
 * generates a concise LLM summary of the oldest messages so that
 * early context (original problem, key decisions) is preserved instead
 * of being silently dropped.
 *
 * Uses the `routing` task-type model (budget-tier) to keep costs low.
 *
 * **Extension, not regeneration.** The summary covers a *prefix* of the
 * conversation and is persisted on the `AiConversation` row with the id of the
 * newest message it covers. When the prefix has to grow, the caller passes the
 * stored text as `previousSummary` and only the messages *after* it — so the
 * cost of a summarisation is proportional to what has been added since the last
 * one, not to the length of the conversation. It also means content that has
 * scrolled out of the caller's 200-message load window survives, folded into
 * the text rather than lost with the rows.
 *
 * Before #654 the caller re-derived the whole prefix on every single turn: it
 * pinned the boundary of a *sliding* window and compared for exact equality, so
 * the cache could not hit. Do not reintroduce a whole-prefix call here on the
 * assumption it is rare.
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

const PRESERVE_CLAUSE = `- The user's original problem or request
- Key decisions made during the conversation
- Important facts, constraints, or context established
- The current state of the discussion

Be factual and brief. Do not add commentary. Write in third person (e.g. "The user asked about..." / "The assistant explained...").`;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Given the conversation history below, produce a concise summary that preserves:
${PRESERVE_CLAUSE}`;

/**
 * The extension prompt. Everything the earlier summary established has to
 * survive the fold — a model that treats the new messages as the whole story
 * silently erases the start of the conversation, and nothing downstream would
 * notice because the output is still a plausible summary.
 */
const EXTEND_SYSTEM_PROMPT = `You are a conversation summarizer. You are given a summary of the earlier part of a conversation, followed by the messages that came after it. Produce a single updated summary covering BOTH — the earlier summary's content must be carried forward, not replaced.

Preserve:
${PRESERVE_CLAUSE}`;

const FALLBACK_MESSAGE = '[Summary unavailable — earlier messages omitted]';

/**
 * Is this stored text the placeholder rather than a real summary?
 *
 * Needed because rows written before #654 persisted `fellBack` results
 * unconditionally — the pre-fix `aiConversation.update` sat outside any
 * `fellBack` check — so live conversations exist whose `summary` column is
 * literally {@link FALLBACK_MESSAGE} with a valid pin beside it. Treating one
 * as real would render "Conversation summary of N earlier messages" above an
 * apology, and worse, fold it into every future summary under an extend prompt
 * that says the earlier content "must be carried forward, not replaced".
 */
export function isPlaceholderSummary(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  // `!trimmed` covers null, undefined, '' and whitespace-only. The last is
  // defensive rather than observed — `summary` is `String?` and nothing is known
  // to write blanks into it. (An earlier draft of this comment claimed the
  // predicate replaced a `summary?.trim()` test that had existed here; it had
  // not. The whitespace branch stands on its own merits and needs no invented
  // pedigree.)
  return !trimmed || trimmed === FALLBACK_MESSAGE;
}

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
 * Attribution and continuation for a summarisation call.
 *
 * `agentId` and `conversationId` are **foreign keys** on `AiCostLog`
 * (`AiAgent.id` / `AiConversation.id`). Before #654 this module passed the
 * literals `'system'` and `'summary'`, which violated both: `logCost` caught
 * the P2003, returned `null`, and the call was `void`-ed — so every summary
 * ever generated cost real money and left no row. Pass real ids or pass
 * nothing; anything else is silently discarded.
 */
export interface SummarizeOptions {
  /**
   * The summary text this call extends. When set, only `messages` (the rows
   * that come *after* what it covers) are sent, and the model is asked to fold
   * them in — so a long conversation never re-derives its whole prefix.
   */
  previousSummary?: string;
  /** Owning agent — must be a real `AiAgent.id`. */
  agentId?: string;
  /** Owning conversation — must be a real `AiConversation.id`. */
  conversationId?: string;
  /**
   * The caller's cost-log carrier. An evaluation run tags subject spend with
   * `metadata.evaluationRunId` and reads it back when rolling the run up, so
   * without this a summarisation made during an eval is spend the run cannot
   * see — the #600 class, one boundary further out.
   */
  costLogMetadata?: Record<string, unknown>;
  /**
   * The user whose turn triggered this summarisation. The summariser has no
   * session of its own — it runs as a side effect of someone else's chat
   * turn — so attribution has to be handed in, exactly like `agentId` and
   * `conversationId` above. Without it a summary's spend is the one part of
   * a conversation's cost with no one attached to it.
   */
  userId?: string | null;
}

/**
 * Summarize a list of conversation messages using a budget-tier LLM.
 *
 * With `options.previousSummary` this **extends** that summary with
 * `messages`; without it, `messages` are summarised from scratch. The caller
 * decides which by tracking how much of the conversation the stored summary
 * already covers.
 *
 * On failure (provider unavailable, LLM error), returns a fallback
 * string rather than throwing — summarization should never block the
 * main chat flow. The caller is responsible for distinguishing the
 * fallback path via `result.fellBack` if it wants different UX, and in
 * particular **must not persist a `fellBack` result**: doing so would
 * replace a good summary with a placeholder on one transient provider error.
 */
export async function summarizeMessages(
  messages: HistoryRow[],
  providerSlug: string,
  fallbackSlugs: string[],
  options: SummarizeOptions = {}
): Promise<SummarizeResult> {
  if (messages.length === 0) {
    // Nothing to fold in. Hand back what we were given rather than the
    // placeholder — returning `FALLBACK_MESSAGE` here would let a caller that
    // persists the result erase a perfectly good summary with a no-op call.
    return { summary: options.previousSummary ?? FALLBACK_MESSAGE, fellBack: true };
  }

  const extending = typeof options.previousSummary === 'string' && options.previousSummary !== '';

  try {
    const model = await getDefaultModelForTask('routing');
    const { provider, usedSlug } = await getProviderWithFallbacks(providerSlug, fallbackSlugs);

    const formatted = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
    const userContent = extending
      ? `[Summary of the conversation so far]\n${options.previousSummary}\n\n[Messages since that summary]\n${formatted}`
      : formatted;

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
            {
              role: 'system',
              content: extending ? EXTEND_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT,
            },
            { role: 'user', content: userContent },
          ],
          { model, maxTokens: 500 }
        );

        setSpanAttributes(span, {
          [GEN_AI_RESPONSE_MODEL]: model,
          [GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
          [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage.inputTokens + response.usage.outputTokens,
        });

        // Fire-and-forget cost log for the summary call. `operation` stays
        // `CHAT` — it is a chat completion billed to this agent, and the Costs
        // page should total it as such — with the kind in metadata so
        // analytics can separate summarisation from turns the user asked for.
        void logCost({
          ...(options.agentId ? { agentId: options.agentId } : {}),
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          ...(options.userId ? { userId: options.userId } : {}),
          model,
          provider: usedSlug,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          operation: CostOperation.CHAT,
          // Caller keys first, this module's own facts last — the precedence
          // rule every cost sink in the engine follows (#600). A caller must
          // not be able to relabel a summarisation as something else.
          metadata: {
            ...(options.costLogMetadata ?? {}),
            kind: 'conversation_summary',
            messageCount: messages.length,
            extended: extending,
          },
          traceId: span.traceId(),
          spanId: span.spanId(),
        });

        // An empty completion is a failure like any other — a content filter, or
        // a reasoning model spending `maxTokens: 500` before emitting text — so
        // it falls back to the stored summary exactly as the `catch` does. It
        // did not, which made this the one failure path that discarded a good
        // summary.
        //
        // `fellBack` is derived from the RAW content, not by comparing the
        // result to the placeholder: with the fallback in place that comparison
        // would report success whenever `previousSummary` was returned, and the
        // caller would persist an unchanged summary while advancing the pin over
        // messages it does not describe.
        const generated = response.content.trim();
        const summary = generated || options.previousSummary || FALLBACK_MESSAGE;
        const cost = calculateCost(model, response.usage.inputTokens, response.usage.outputTokens);
        return {
          summary,
          fellBack: generated.length === 0,
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
      extending,
    });
    // The previous summary, when there is one, beats the placeholder: it is
    // still true of everything it covered, and it is what the caller will keep
    // (a `fellBack` result is never persisted).
    return { summary: options.previousSummary ?? FALLBACK_MESSAGE, fellBack: true };
  }
}
