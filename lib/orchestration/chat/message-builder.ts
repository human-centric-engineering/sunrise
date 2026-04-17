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
import type { LlmMessage, LlmRole } from '@/lib/orchestration/llm/types';
import { MAX_HISTORY_MESSAGES } from '@/lib/orchestration/chat/types';

export interface HistoryRow {
  role: string;
  content: string;
  toolCallId?: string | null;
}

export interface BuildMessagesArgs {
  systemInstructions: string;
  contextBlock: string | null;
  history: HistoryRow[];
  newUserMessage: string;
  /** Rolling summary of messages older than the truncation window. */
  conversationSummary?: string;
}

/**
 * Compose an `LlmMessage[]` from the agent config, optional entity
 * context, prior conversation rows, and the new user turn.
 */
export function buildMessages(args: BuildMessagesArgs): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: args.systemInstructions }];

  if (args.contextBlock) {
    messages.push({ role: 'system', content: args.contextBlock });
  }

  const history = args.history;
  let truncated = history;
  if (history.length > MAX_HISTORY_MESSAGES) {
    const dropped = history.length - MAX_HISTORY_MESSAGES;
    truncated = history.slice(-MAX_HISTORY_MESSAGES);
    if (args.conversationSummary) {
      messages.push({
        role: 'system',
        content: `[Conversation summary of ${dropped} earlier messages]\n\n${args.conversationSummary}`,
      });
    } else {
      messages.push({
        role: 'system',
        content: `[... ${dropped} older messages omitted for context window ...]`,
      });
    }
  }

  for (const row of truncated) {
    const role = normaliseRole(row.role);
    if (role === 'tool' && row.toolCallId) {
      messages.push({ role: 'tool', content: row.content, toolCallId: row.toolCallId });
    } else {
      messages.push({ role, content: row.content });
    }
  }

  messages.push({ role: 'user', content: args.newUserMessage });
  return messages;
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
