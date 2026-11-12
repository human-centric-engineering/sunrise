/**
 * Placing a chat turn the LLM privacy layer refused under `block` (§127
 * t-1017): which part of what the turn sent held personal details, what can
 * be left out so the conversation goes on, and which words the reader gets.
 *
 * The privacy stage reports positions in the messages it was given
 * ({@link PrivacyFindingLocation}), never what it found. The message builder
 * says where each message came from ({@link MessageSource}). Together they
 * give one of three cases:
 * - **this turn** — the user's message, or a tool result the turn fetched.
 *   The turn's rows are left out (t-1014); asking again without the details
 *   works.
 * - **earlier** — an earlier row, or the stored summary, written before the
 *   mode was `block` or by a turn whose own marking failed. The exchanges
 *   those rows are in are left out too, and the summary is replaced by a
 *   note of how many messages it no longer describes (owner ruling
 *   2026-11-12: the conversation carries on and forgets), so asking again
 *   works.
 * - **setup** — the system prompt, the entity context, the user's memories or
 *   an opening the server wrote. Nothing the reader can change; they are told
 *   to ask an administrator.
 *
 * @see .context/privacy/llm-privacy-layer.md — *What is built (t-1017)*
 */
import type { MessageSource } from '@/lib/orchestration/chat/message-builder';
import { PRIVACY_BLOCKED } from '@/lib/orchestration/llm/provider';
import type { PrivacyFindingLocation } from '@/lib/orchestration/llm/privacy-stage';

/** Refused for personal details in an earlier message or the stored summary. */
export const PRIVACY_BLOCKED_EARLIER = 'privacy_blocked_earlier';

/** Refused for personal details in the assistant's setup: nothing the reader can change. */
export const PRIVACY_BLOCKED_SETUP = 'privacy_blocked_setup';

export type PrivacyBlockedChatCode =
  typeof PRIVACY_BLOCKED | typeof PRIVACY_BLOCKED_EARLIER | typeof PRIVACY_BLOCKED_SETUP;

/** A part of the assistant's setup that held personal details. Logged; never a value. */
export type SetupSource = 'system_prompt' | 'context' | 'memories' | 'opening_turn' | 'note';

export interface PlacedPrivacyRefusal {
  code: PrivacyBlockedChatCode;
  /**
   * Earlier rows to leave out of later history: every row of each earlier
   * exchange that held personal details, from its user message to the row
   * before the next one, so no reply is resent without its question, or a
   * question without its reply.
   */
  earlierRowIds: string[];
  /** Whether the stored summary held personal details: to be replaced by a note. */
  summary: boolean;
  /** The parts of the setup that held personal details, each once. */
  setup: SetupSource[];
  /** Whether something this turn sent (its message, or a tool result) held them. */
  turn: boolean;
}

/** What the handler built a turn's first call from, before the tool loop added to it. */
export interface BuiltChatRequest {
  /** The built prefix's sources; messages past it were added by the tool loop this turn. */
  sources: readonly MessageSource[];
  /** Each row of the history the builder was given, by index, oldest first. */
  historyRows: readonly { id: string; role: string }[];
}

/** What the handler knows about the call it made. */
export interface SentChatCall extends BuiltChatRequest {
  /** How many messages the call carried. */
  messageCount: number;
}

/** The rows of the exchange `index` is in: from its user message to the row before the next. */
function exchangeOf(rows: BuiltChatRequest['historyRows'], index: number): number[] {
  let start = index;
  while (start > 0 && rows[start].role !== 'user') start--;
  let end = index + 1;
  while (end < rows.length && rows[end].role !== 'user') end++;
  return Array.from({ length: end - start }, (_, k) => start + k);
}

/**
 * Place a refusal. Null when the stage gave no location, or one for a call of
 * a different length than the handler sent: then the location is not this
 * call's, and the caller falls back to leaving out only the turn.
 */
export function placePrivacyRefusal(
  found: PrivacyFindingLocation | undefined,
  sent: SentChatCall
): PlacedPrivacyRefusal | null {
  if (!found || found.messageCount !== sent.messageCount) return null;
  const earlierRows = new Set<number>();
  const setup = new Set<SetupSource>();
  let summary = false;
  let turn = false;
  for (const index of found.messageIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= sent.messageCount) return null;
    const source = sent.sources[index];
    // Past the built prefix: an assistant tool call or a tool result this turn added.
    if (source === undefined) {
      turn = true;
      continue;
    }
    switch (source.kind) {
      case 'user_message':
        turn = true;
        break;
      case 'history': {
        if (sent.historyRows[source.historyIndex] === undefined) return null;
        for (const i of exchangeOf(sent.historyRows, source.historyIndex)) earlierRows.add(i);
        break;
      }
      case 'summary':
        summary = true;
        break;
      default:
        setup.add(source.kind);
    }
  }
  const earlierRowIds = [...earlierRows].sort((a, b) => a - b).map((i) => sent.historyRows[i].id);
  // An empty location is not a place: nothing to leave out but the turn.
  if (!turn && !summary && earlierRowIds.length === 0 && setup.size === 0) return null;
  // The setup wins: whatever else is left out, asking again cannot work until
  // an administrator changes it. Then anything earlier: once it is left out,
  // asking again works.
  const code: PrivacyBlockedChatCode =
    setup.size > 0
      ? PRIVACY_BLOCKED_SETUP
      : summary || earlierRowIds.length > 0
        ? PRIVACY_BLOCKED_EARLIER
        : PRIVACY_BLOCKED;
  return { code, earlierRowIds, summary, setup: [...setup], turn };
}
