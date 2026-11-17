/**
 * Placing a chat turn the LLM privacy layer refused under `block` (§127
 * t-1017): which part of what the turn sent held personal details, what can
 * be left out so the conversation goes on, and which words the reader gets.
 *
 * The privacy stage reports positions in the messages it was given
 * ({@link PrivacyFindingLocation}), never what it found. The message builder
 * says where each message came from ({@link MessageSource}). A message is
 * named only for details it holds on its own: not for a value a detector
 * matched only because it learned it from another message, such as a
 * surname after the full name (t-1018). Together they give one of four
 * cases, in this order:
 * - **this turn** — the user's message, or a tool result the turn fetched.
 *   The turn's rows are left out (t-1014); asking again without the details
 *   works.
 * - **setup** — the system prompt, the entity context, or an opening the
 *   server wrote. Nothing the reader can change; they are told to ask an
 *   administrator.
 * - **earlier** — an earlier row, or the stored summary, written before the
 *   mode was `block` or by a turn whose own marking failed. The exchanges
 *   those rows are in are left out too, and the summary is replaced by a
 *   note of how many messages it no longer describes (owner ruling
 *   2026-11-12: the conversation carries on and forgets), so asking again
 *   works.
 * - **a memory** — something the agent remembered about this user, written
 *   before the mode was `block`. It is sent in every conversation the user
 *   has with the agent, and nothing else can remove it, so the memory is
 *   deleted (t-1018; owner ruling 2026-11-12: carry on and forget) and asking
 *   again works.
 *
 * A refusal for confidential content (§130, t-1037) is placed the same way,
 * from where the stage found content of the refused group, and told with its
 * own codes ({@link PRIVACY_CONFIDENTIAL} and the three below).
 *
 * @see .context/privacy/llm-privacy-layer.md — *What is built (t-1017)*, *(t-1018)*, *Confidential content*
 */
import type { MessageSource } from '@/lib/orchestration/chat/message-builder';
import { PRIVACY_BLOCKED, PRIVACY_CONFIDENTIAL } from '@/lib/orchestration/llm/provider';
import type { PrivacyFindingLocation } from '@/lib/orchestration/llm/privacy-stage';

/** Refused for personal details in an earlier message or the stored summary. */
export const PRIVACY_BLOCKED_EARLIER = 'privacy_blocked_earlier';

/** Refused for personal details in the assistant's setup: nothing the reader can change. */
export const PRIVACY_BLOCKED_SETUP = 'privacy_blocked_setup';

/** Refused for personal details in something the agent remembered about the user (t-1018). */
export const PRIVACY_BLOCKED_MEMORY = 'privacy_blocked_memory';

/**
 * The same four places for a refusal for confidential content (§130): the
 * turn ({@link PRIVACY_CONFIDENTIAL}), an earlier message, the setup, or a
 * memory. What is left out is the same; the reader is told about
 * confidential content rather than personal details.
 */
export const PRIVACY_CONFIDENTIAL_EARLIER = 'privacy_confidential_earlier';
export const PRIVACY_CONFIDENTIAL_SETUP = 'privacy_confidential_setup';
export const PRIVACY_CONFIDENTIAL_MEMORY = 'privacy_confidential_memory';

export type PrivacyBlockedChatCode =
  | typeof PRIVACY_BLOCKED
  | typeof PRIVACY_BLOCKED_EARLIER
  | typeof PRIVACY_BLOCKED_SETUP
  | typeof PRIVACY_BLOCKED_MEMORY
  | typeof PRIVACY_CONFIDENTIAL
  | typeof PRIVACY_CONFIDENTIAL_EARLIER
  | typeof PRIVACY_CONFIDENTIAL_SETUP
  | typeof PRIVACY_CONFIDENTIAL_MEMORY;

/**
 * What a refusal was for: personal details under the `block` mode (§127), or
 * confidential content under a group's policy (§130).
 */
export type PrivacyRefusalKind = 'personal_details' | 'confidential';

const CODES: Record<
  PrivacyRefusalKind,
  Record<'turn' | 'setup' | 'earlier' | 'memory', PrivacyBlockedChatCode>
> = {
  personal_details: {
    turn: PRIVACY_BLOCKED,
    setup: PRIVACY_BLOCKED_SETUP,
    earlier: PRIVACY_BLOCKED_EARLIER,
    memory: PRIVACY_BLOCKED_MEMORY,
  },
  confidential: {
    turn: PRIVACY_CONFIDENTIAL,
    setup: PRIVACY_CONFIDENTIAL_SETUP,
    earlier: PRIVACY_CONFIDENTIAL_EARLIER,
    memory: PRIVACY_CONFIDENTIAL_MEMORY,
  },
};

/** The kind of a chat refusal's `ProviderError` code, or `null` when it is not one to place. */
export function privacyRefusalKind(code: string): PrivacyRefusalKind | null {
  if (code === PRIVACY_BLOCKED) return 'personal_details';
  if (code === PRIVACY_CONFIDENTIAL) return 'confidential';
  return null;
}

/**
 * A part of the assistant's setup that held personal details. Logged; never a
 * value. `memories` is the fixed heading the memories follow, not a memory.
 */
export type SetupSource = 'system_prompt' | 'context' | 'memories' | 'opening_turn' | 'note';

/**
 * One of the user's memories a turn sent: which row, and when it was last
 * written, so deleting it can skip one rewritten since (t-1018).
 */
export interface SentMemory {
  id: string;
  updatedAt: Date;
}

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
  /** The user's memories that held personal details, each once: to be deleted. */
  memories: SentMemory[];
  /** The parts of the setup that held personal details, each once. */
  setup: SetupSource[];
  /** Whether something this turn sent (its message, or a tool result) held them. */
  turn: boolean;
}

/** What the handler built a turn's first call from, before the tool loop added to it. */
export interface BuiltChatRequest {
  /** The built prefix's sources; messages past it were added by the tool loop this turn. */
  sources: readonly MessageSource[];
  /**
   * Each row of the history the builder was given, by index, oldest first,
   * and whether it is a finished reply: an assistant row with text and no
   * tool calls. (An empty one is a marker, such as a pending approval's.)
   */
  historyRows: readonly { id: string; role: string; finishedReply: boolean }[];
  /** Each of the user's memories the builder was given, by index. */
  memories: readonly SentMemory[];
}

/** What the handler knows about the call it made. */
export interface SentChatCall extends BuiltChatRequest {
  /** How many messages the call carried. */
  messageCount: number;
}

/**
 * Whether row `i` begins an exchange: a user message, or an assistant row
 * straight after a finished reply, which is a turn the agent opened (#474)
 * and which persists no user row.
 */
function opensExchange(rows: BuiltChatRequest['historyRows'], i: number): boolean {
  const row = rows[i];
  if (row.role === 'user') return true;
  return row.role === 'assistant' && rows[i - 1]?.finishedReply === true;
}

/** The rows of the exchange `index` is in: from where it begins to the row before the next. */
function exchangeOf(rows: BuiltChatRequest['historyRows'], index: number): number[] {
  let start = index;
  while (start > 0 && !opensExchange(rows, start)) start--;
  let end = index + 1;
  while (end < rows.length && !opensExchange(rows, end)) end++;
  return Array.from({ length: end - start }, (_, k) => start + k);
}

/**
 * Place a refusal. Null when the stage gave no location, or one for a call of
 * a different length than the handler sent: then the location is not this
 * call's, and the caller falls back to leaving out only the turn.
 */
export function placePrivacyRefusal(
  found: PrivacyFindingLocation | undefined,
  sent: SentChatCall,
  kind: PrivacyRefusalKind = 'personal_details'
): PlacedPrivacyRefusal | null {
  const codes = CODES[kind];
  if (!found || found.messageCount !== sent.messageCount) return null;
  const earlierRows = new Set<number>();
  const memories = new Set<number>();
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
      case 'memory':
        if (sent.memories[source.memoryIndex] === undefined) return null;
        memories.add(source.memoryIndex);
        break;
      default:
        setup.add(source.kind);
    }
  }
  // An empty location is not a place: nothing to leave out but the turn.
  if (!turn && !summary && earlierRows.size === 0 && memories.size === 0 && setup.size === 0) {
    return null;
  }
  // One case wins, and only it acts; whatever else holds details is placed
  // by the next attempt. The stage leaves out values a detector says it only
  // learned elsewhere (`DetectedSpan.learned`), so the parts named here hold
  // details of their own as far as the detectors can tell. That holds for
  // core's; a detector that learns without saying so, or a call where every
  // span was learned, can still name a part that holds none, and the next
  // attempt shows it. So the order is what decides what is lost first:
  // - This turn first: asking again without the details works, and nothing
  //   else is lost.
  // - Then the setup: until an administrator changes it, nothing removed
  //   here helps, so nothing is.
  // - Then anything earlier, which is left out, so asking again works.
  // - Then a memory, which is deleted. Last because that cannot be undone
  //   and reaches every conversation the user has with the agent.
  const none = { earlierRowIds: [], summary: false, memories: [], setup: [] };
  if (turn) return { ...none, code: codes.turn, turn };
  if (setup.size > 0) return { ...none, code: codes.setup, setup: [...setup], turn };
  if (summary || earlierRows.size > 0) {
    const earlierRowIds = [...earlierRows].sort((a, b) => a - b).map((i) => sent.historyRows[i].id);
    return { ...none, code: codes.earlier, earlierRowIds, summary, turn };
  }
  const placed = [...memories].sort((a, b) => a - b).map((i) => sent.memories[i]);
  return { ...none, code: codes.memory, memories: placed, turn };
}
