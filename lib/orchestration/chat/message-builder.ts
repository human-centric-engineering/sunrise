/**
 * Message array builder
 *
 * Small pure helper that composes the `LlmMessage[]` passed into a
 * provider. The system prompt is always the first message and stays
 * stable across turns (KV-cache friendly); an optional context block
 * is appended as a second `system` message; conversation history is
 * truncated to the last N entries with a visible marker for anything
 * dropped; the new user turn comes last.
 *
 * No state. No DB access. No logging beyond a single warn for
 * malformed roles. Internal to the chat module — not re-exported
 * from the barrel.
 */

import { logger } from '@/lib/logging';
import type { ContentPart, LlmMessage, LlmRole } from '@/lib/orchestration/llm/types';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';
import { MAX_HISTORY_MESSAGES } from '@/lib/orchestration/chat/types';
import {
  estimateMessagesTokens,
  estimateTokens,
  truncateToTokenBudget,
} from '@/lib/orchestration/chat/token-estimator';
import type { InputBreakdown, InputBreakdownPart } from '@/types/orchestration';

/**
 * Estimated token cost per attachment (image/document).
 * LLM providers charge a fixed token amount per image regardless of
 * base64 size (typically 1 000–1 600 tokens). We use the upper bound
 * so history truncation stays conservative.
 */
const ATTACHMENT_OVERHEAD_TOKENS = 1600;

export interface HistoryRow {
  role: string;
  content: string;
  toolCallId?: string | null;
}

export interface UserMemoryEntry {
  key: string;
  value: string;
}

export interface BuildMessagesArgs {
  systemInstructions: string;
  contextBlock: string | null;
  history: HistoryRow[];
  newUserMessage: string;
  /** File attachments (images, documents) to include with the user message. */
  attachments?: ChatAttachment[];
  /** Rolling summary of messages older than the truncation window. */
  conversationSummary?: string;
  /** Per-user-per-agent memories to inject into context. */
  userMemories?: UserMemoryEntry[];
  /** Brand voice instructions appended to the system prompt. */
  brandVoiceInstructions?: string | null;
  /**
   * Model's context window size in tokens. When set, token-aware
   * truncation is used instead of the fixed message count limit.
   */
  contextWindowTokens?: number;
  /** Tokens to reserve for the model's response (default: 4096). */
  reserveTokens?: number;
  /**
   * Target model id — selects the per-provider tokeniser used by the
   * truncation logic. Without it we fall back to the legacy
   * chars / 3.5 heuristic.
   */
  modelId?: string;
  /**
   * Per-agent override for the message-count cap. When set, this
   * supersedes the platform default {@link MAX_HISTORY_MESSAGES} for
   * this turn only — the rolling-summary path already substitutes a
   * `[Conversation summary of N earlier messages]` block for anything
   * dropped, so older context survives via summary rather than verbatim.
   * `0` is meaningful: a fully-stateless agent that never re-sends
   * prior turns. `null`/`undefined` ⇒ use the platform default.
   */
  maxHistoryMessages?: number | null;
}

/**
 * Compose an `LlmMessage[]` from the agent config, optional entity
 * context, prior conversation rows, and the new user turn.
 */
export function buildMessages(args: BuildMessagesArgs): LlmMessage[] {
  return buildMessagesAndBreakdown(args).messages;
}

export interface BuildMessagesResult {
  messages: LlmMessage[];
  /**
   * Per-section input-token breakdown for the initial LLM call. Does
   * not include `toolDefinitions` (those are passed separately by the
   * caller). Tokens are estimated via the configured tokeniser.
   */
  breakdown: InputBreakdown;
}

/**
 * Same as {@link buildMessages} but also returns an estimated breakdown
 * of the input-token usage attributed to each section (system prompt,
 * context block, user memories, conversation summary, history, user
 * message, attachments). The streaming handler forwards this breakdown
 * on the `done` SSE event so admin chat surfaces can explain why a
 * tiny user message can still cost hundreds of input tokens.
 */
export function buildMessagesAndBreakdown(args: BuildMessagesArgs): BuildMessagesResult {
  const modelId = args.modelId;

  const systemPrompt = args.brandVoiceInstructions
    ? `${args.systemInstructions}\n\n[Brand Voice]\n${args.brandVoiceInstructions}`
    : args.systemInstructions;
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }];

  const breakdown: InputBreakdown = {
    systemPrompt: makePart(systemPrompt, modelId),
    userMessage: makePart(args.newUserMessage, modelId),
    totalEstimated: 0,
  };

  if (args.contextBlock) {
    messages.push({ role: 'system', content: args.contextBlock });
    breakdown.contextBlock = makePart(args.contextBlock, modelId);
  }

  if (args.userMemories && args.userMemories.length > 0) {
    const formatted = args.userMemories.map((m) => `- ${m.key}: ${m.value}`).join('\n');
    const memoryBlock = `[User memories]\nThe following are things you have previously remembered about this user:\n${formatted}`;
    messages.push({ role: 'system', content: memoryBlock });
    breakdown.userMemories = {
      ...makePart(memoryBlock, modelId),
      count: args.userMemories.length,
    };
  }

  const history = args.history;
  let truncated = history;
  let droppedCount = 0;

  // Resolve the message-count cap. Per-agent override wins; the platform
  // default applies when the agent leaves it unset. `0` is honoured —
  // a stateless agent gets no prior history (verbatim), only summary.
  const messageCap =
    typeof args.maxHistoryMessages === 'number' && args.maxHistoryMessages >= 0
      ? args.maxHistoryMessages
      : MAX_HISTORY_MESSAGES;

  // Hard cap to avoid loading too many messages
  if (history.length > messageCap) {
    droppedCount = history.length - messageCap;
    truncated = messageCap > 0 ? history.slice(-messageCap) : [];
  }

  // Token-aware truncation: if we know the context window, calculate
  // how much budget is available for history after accounting for
  // system messages, the new user message, and the response reserve.
  if (args.contextWindowTokens && args.contextWindowTokens > 0) {
    const reserveTokens = args.reserveTokens ?? 4096;
    const systemTokens = estimateMessagesTokens(messages, args.modelId);
    const userTokens = estimateMessagesTokens(
      [{ role: 'user', content: args.newUserMessage }],
      args.modelId
    );
    const attachmentTokens = (args.attachments?.length ?? 0) * ATTACHMENT_OVERHEAD_TOKENS;
    const historyBudget =
      args.contextWindowTokens - reserveTokens - systemTokens - userTokens - attachmentTokens;

    if (historyBudget > 0) {
      const historyMessages: LlmMessage[] = truncated.map((row) => ({
        role: normaliseRole(row.role),
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      }));
      const { droppedCount: tokenDropped } = truncateToTokenBudget(
        historyMessages,
        historyBudget,
        args.modelId
      );
      if (tokenDropped > 0) {
        droppedCount += tokenDropped;
        truncated = truncated.slice(tokenDropped);
      }
    } else {
      // No budget for history at all
      droppedCount += truncated.length;
      truncated = [];
    }
  }

  if (droppedCount > 0) {
    if (args.conversationSummary) {
      const summaryBlock = `[Conversation summary of ${droppedCount} earlier messages]\n\n${args.conversationSummary}`;
      messages.push({ role: 'system', content: summaryBlock });
      breakdown.conversationSummary = makePart(summaryBlock, modelId);
    } else {
      messages.push({
        role: 'system',
        content: `[... ${droppedCount} older messages omitted for context window ...]`,
      });
    }
  }

  let historyChars = 0;
  let historyTokens = 0;
  let historyMessageCount = 0;
  for (const row of truncated) {
    const role = normaliseRole(row.role);
    // Skip empty-content assistant messages — these are persisted as
    // markers for UI state (e.g. the synthetic message that carries
    // `metadata.pendingApproval` when a workflow paused for approval).
    // Anthropic's Messages API rejects content blocks with empty
    // strings, so leaving them in the LLM history breaks the next
    // turn after the user submits a follow-up.
    if (role === 'assistant' && (!row.content || row.content.length === 0)) {
      continue;
    }
    if (role === 'tool' && row.toolCallId) {
      messages.push({ role: 'tool', content: row.content, toolCallId: row.toolCallId });
    } else {
      messages.push({ role, content: row.content });
    }
    historyChars += row.content.length;
    historyTokens += estimateTokens(row.content, modelId);
    historyMessageCount += 1;
  }

  if (historyMessageCount > 0 || droppedCount > 0) {
    breakdown.conversationHistory = {
      tokens: historyTokens,
      chars: historyChars,
      messageCount: historyMessageCount,
      droppedCount,
    };
  }

  // Build the user message — multimodal if attachments are present
  if (args.attachments && args.attachments.length > 0) {
    const parts: ContentPart[] = [{ type: 'text', text: args.newUserMessage }];
    for (const attachment of args.attachments) {
      if (attachment.mediaType.startsWith('image/')) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            mediaType: attachment.mediaType,
            data: attachment.data,
          },
        });
      } else {
        parts.push({
          type: 'document',
          source: {
            type: 'base64',
            mediaType: attachment.mediaType,
            data: attachment.data,
          },
          name: attachment.name,
        });
      }
    }
    messages.push({ role: 'user', content: parts });
    breakdown.attachments = {
      tokens: args.attachments.length * ATTACHMENT_OVERHEAD_TOKENS,
      count: args.attachments.length,
    };
  } else {
    messages.push({ role: 'user', content: args.newUserMessage });
  }

  breakdown.totalEstimated =
    breakdown.systemPrompt.tokens +
    (breakdown.contextBlock?.tokens ?? 0) +
    (breakdown.userMemories?.tokens ?? 0) +
    (breakdown.conversationSummary?.tokens ?? 0) +
    (breakdown.conversationHistory?.tokens ?? 0) +
    (breakdown.attachments?.tokens ?? 0) +
    breakdown.userMessage.tokens;

  return { messages, breakdown };
}

/** Build a breakdown part for a single text chunk. Includes the raw text. */
function makePart(text: string, modelId: string | undefined): InputBreakdownPart {
  return {
    tokens: estimateTokens(text, modelId),
    chars: text.length,
    content: text,
  };
}

/**
 * Whitelist the four roles every provider understands. Unknown roles
 * are coerced to `'user'` with a warn so a corrupt DB row never
 * crashes the provider.
 */
function normaliseRole(role: string): LlmRole {
  switch (role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'tool':
      return role;
    default:
      logger.warn('buildMessages: unknown role, coercing to user', { role });
      return 'user';
  }
}
