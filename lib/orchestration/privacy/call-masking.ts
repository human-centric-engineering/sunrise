/**
 * Masking one provider call's messages, and restoring what comes back (§127,
 * t-992).
 *
 * The privacy stage detects once, over every text the call would send joined
 * into one input, so a name tier C learns in one message is found in the
 * others. This module maps what was found back onto the messages and masks
 * them with **one** token session, in order, so numbering is by first
 * appearance across the whole call. History is append-only, so every call of
 * a conversation numbers the same values the same way.
 *
 * Nothing here mutates the caller's messages: the caller keeps the real
 * conversation, and the next call masks it again from scratch. That is what
 * makes the layer stateless (spec § Placeholders, *No vault*).
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import type {
  ContentPart,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import type { EntityType, TokenSession } from '@/lib/privacy/adapters/types';
import { maskText, PLACEHOLDER_INSTRUCTION, type MaskSpan } from '@/lib/privacy/pii/mask';
import { LITERAL_TYPE } from '@/lib/privacy/pii/token-strategy';
import { restoreText, restoreValue } from '@/lib/privacy/pii/restore';
import { isRecord } from '@/lib/utils';
import { StreamRestorer } from '@/lib/privacy/pii/stream-restore';
import { escapeRegExp } from '@/lib/privacy/pii/text';

/** Between two pieces in the joined input. A blank line, so no pattern runs across it. */
export const PIECE_SEPARATOR = '\n\n';

/**
 * Every string inside a parsed value, depth first, each key before its value,
 * replaced by `fn`. A key is a string a model can write a value into (a map
 * keyed by email address), so it is scanned and masked like a value.
 */
function mapValue(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapValue(v, fn));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Defined, not assigned: parsed JSON can carry an own `__proto__` key,
      // which an assignment would turn into the object's prototype and lose.
      Object.defineProperty(out, fn(k), {
        value: mapValue(v, fn),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function mapToolCall(call: LlmToolCall, fn: (text: string) => string): LlmToolCall {
  const args = mapValue(call.arguments, fn);
  return { ...call, arguments: isRecord(args) ? args : call.arguments };
}

/**
 * The messages with every text `fn` returns in place of the original, visited
 * in a fixed order: each message's text content (a string, or its text parts),
 * then the strings in its tool-call arguments. Images, documents and provider
 * reasoning blocks are left as they are: attachments are their own feature,
 * and reasoning goes back unchanged to the provider that wrote it (its
 * signature covers it).
 */
export function mapMessageTexts(
  messages: readonly LlmMessage[],
  fn: (text: string) => string
): LlmMessage[] {
  return messages.map((m) => {
    const content: string | ContentPart[] =
      typeof m.content === 'string'
        ? fn(m.content)
        : m.content.map((part) => (part.type === 'text' ? { ...part, text: fn(part.text) } : part));
    return {
      ...m,
      content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => mapToolCall(c, fn)) } : {}),
    };
  });
}

/** The strings in a parsed value, in {@link mapValue}'s order, without copying it. */
function collectValue(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectValue(v, out);
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectValue(v, out);
    }
  }
}

/**
 * Every text {@link mapMessageTexts} visits, in its order. Collected without
 * copying the messages: it runs on every scanned call, over the whole history.
 * A test holds the two orders together.
 */
export function messagePieces(messages: readonly LlmMessage[]): string[] {
  const pieces: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') pieces.push(m.content);
    else for (const part of m.content) if (part.type === 'text') pieces.push(part.text);
    for (const call of m.toolCalls ?? []) collectValue(call.arguments, pieces);
  }
  return pieces;
}

/**
 * Each piece's spans, as offsets in the piece. A span reaching across a
 * separator is split at it, so every character it covered is still masked.
 */
function spansByPiece(pieces: readonly string[], spans: readonly MaskSpan[]): MaskSpan[][] {
  const starts: number[] = [];
  let at = 0;
  for (const p of pieces) {
    starts.push(at);
    at += p.length + PIECE_SEPARATOR.length;
  }
  const out: MaskSpan[][] = pieces.map(() => []);
  for (const s of spans) {
    // The last piece starting at or before the span: a binary search, since
    // a long tool loop has thousands of pieces.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= s.start) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < pieces.length && starts[i] < s.end; i++) {
      const start = Math.max(s.start - starts[i], 0);
      const end = Math.min(s.end - starts[i], pieces[i].length);
      if (start < end) out[i].push({ type: s.type, start, end });
    }
  }
  return out;
}

/**
 * The indices of the messages that hold any of `spans` (offsets in their
 * joined pieces), in order. Positions only, never what was found: a refusal
 * under `block` carries them so its caller can tell which part of what it sent
 * held personal details (§127 t-1017).
 */
export function messagesHoldingSpans(
  messages: readonly LlmMessage[],
  spans: readonly MaskSpan[],
  pieces: readonly string[] = messagePieces(messages)
): number[] {
  if (spans.length === 0) return [];
  const byPiece = spansByPiece(pieces, spans);
  const out: number[] = [];
  let k = 0;
  messages.forEach((m, index) => {
    // The same count `messagePieces` collects for this message.
    const own = messagePieces([m]).length;
    if (byPiece.slice(k, k + own).some((s) => s.length > 0)) out.push(index);
    k += own;
  });
  return out;
}

export interface MaskedMessages {
  messages: LlmMessage[];
  /** Whether any text was replaced: a detected value, or a look-alike. */
  changed: boolean;
}

/**
 * Mask `messages` with the spans found in their joined pieces
 * ({@link messagePieces} joined by {@link PIECE_SEPARATOR}).
 *
 * `escapeLookAlikes` is false for a mode that never restores (`redact`): text
 * that only looks like a placeholder then reaches the model as written.
 */
export function maskMessages(
  messages: readonly LlmMessage[],
  spans: readonly MaskSpan[],
  session: TokenSession,
  declaredTypes: Iterable<EntityType>,
  escapeLookAlikes: boolean,
  options: {
    /** `messagePieces(messages)`, when the caller has it already. */
    pieces?: readonly string[];
  } = {}
): MaskedMessages {
  const pieces = options.pieces ?? messagePieces(messages);
  const byPiece = withEveryCopy(pieces, spansByPiece(pieces, spans), session);
  const types = [...declaredTypes];
  let changed = false;
  let k = 0;
  const masked = mapMessageTexts(messages, (text) => {
    const i = k++;
    const r = maskText(text, byPiece[i], session, types, { escapeLookAlikes });
    if (r.text !== text) changed = true;
    return r.text;
  });
  return { messages: masked, changed };
}

/** Shorter than this, an exact copy is too likely to be part of something else. */
const MIN_COPY_LENGTH = 3;

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** A single word of letters: "Will", "Grace". Its copies are left to the detectors. */
const SINGLE_WORD = /^\p{L}+$/u;

/**
 * `byPiece`, plus a span for every other exact copy of a value already found:
 * found anywhere in this call, or masked by an earlier call in the same scope
 * (the session's entries). A detector that needs context to report a value —
 * a phone number only after a phone word — would otherwise leave its second
 * copy in plaintext beside the placeholder for the first, which ties the two
 * together for the provider.
 *
 * Two limits, both against masking ordinary text:
 * - A copy must stand on its own: where the value begins or ends with a
 *   letter or digit, the character beside it must not be one, so "Ann" never
 *   masks the start of "Annual".
 * - A value that is one word of letters ("Will", "Grace", "May") is not
 *   extended: it is far likelier to be an ordinary word elsewhere ("Will you
 *   always cite sources"), and tier C already finds the other mentions of a
 *   name it learns, with its own care for which ones are names.
 *
 * One pass per piece over a single pattern of every value, longest first, so
 * the cost does not multiply by the number of values. Overlaps are merged by
 * `maskText()`.
 */
function withEveryCopy(
  pieces: readonly string[],
  byPiece: MaskSpan[][],
  session: TokenSession
): MaskSpan[][] {
  const values = new Map<string, EntityType>();
  const add = (value: string, type: EntityType): void => {
    if (value.length < MIN_COPY_LENGTH || SINGLE_WORD.test(value) || values.has(value)) return;
    values.set(value, type);
  };
  for (const e of session.entries()) if (e.type !== LITERAL_TYPE) add(e.value, e.type);
  pieces.forEach((piece, i) => {
    for (const s of byPiece[i]) add(piece.slice(s.start, s.end), s.type);
  });
  if (values.size === 0) return byPiece;
  const pattern = new RegExp(
    [...values.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'g'
  );
  return pieces.map((piece, i) => {
    const out = [...byPiece[i]];
    for (const m of piece.matchAll(pattern)) {
      const value = m[0];
      const at = m.index;
      const end = at + value.length;
      if (WORD_CHAR.test(value[0]) && at > 0 && WORD_CHAR.test(piece[at - 1])) continue;
      if (
        WORD_CHAR.test(value[value.length - 1]) &&
        end < piece.length &&
        WORD_CHAR.test(piece[end])
      )
        continue;
      const type = values.get(value);
      if (type !== undefined) out.push({ type, start: at, end });
    }
    return out;
  });
}

/**
 * The messages with {@link PLACEHOLDER_INSTRUCTION} added to the system
 * prompt: appended to the first system message that is the prompt (not a
 * turn instruction), or as a system message of its own at the start.
 */
export function withPlaceholderInstruction(messages: readonly LlmMessage[]): LlmMessage[] {
  const at = messages.findIndex((m) => m.role === 'system' && m.turnInstruction !== true);
  if (at === -1) return [{ role: 'system', content: PLACEHOLDER_INSTRUCTION }, ...messages];
  return messages.map((m, i) => {
    if (i !== at) return m;
    const content: string | ContentPart[] =
      typeof m.content === 'string'
        ? m.content.length > 0
          ? `${m.content}${PIECE_SEPARATOR}${PLACEHOLDER_INSTRUCTION}`
          : PLACEHOLDER_INSTRUCTION
        : [...m.content, { type: 'text', text: PLACEHOLDER_INSTRUCTION }];
    return { ...m, content };
  });
}

/** What a restorer did, reported once when the response or stream is done. */
export interface RestoreReport {
  restored: number;
  /** Placeholder-shaped text the session never issued, left as written. */
  unresolved: number;
}

/**
 * Puts the real values back into one call's reply (`pseudonymise` only).
 *
 * - Text: `restoreText`, or for a structured reply (`responseFormat`) by
 *   parsing it and restoring the parsed value, so a value containing a quote
 *   cannot break the JSON. A structured reply that does not parse is restored
 *   as text.
 * - Tool calls: `restoreValue` on the parsed arguments, keys included, before
 *   the caller dispatches them, so a capability runs with real values.
 * - Streams: a `StreamRestorer` each for the text and the display reasoning,
 *   releasing what one holds back before any other chunk, so order is kept.
 *   A streamed structured reply is restored as text.
 * - Reasoning blocks are never touched: they go back to the provider as it
 *   wrote them.
 */
export class CallRestorer {
  private restored = 0;
  private unresolved = 0;
  private reported = false;

  constructor(
    private readonly session: TokenSession,
    private readonly declaredTypes: readonly EntityType[],
    private readonly structured: boolean,
    private readonly onReport: (report: RestoreReport) => void
  ) {}

  private count(r: { restored: number; unresolved: readonly string[] }): void {
    this.restored += r.restored;
    this.unresolved += r.unresolved.length;
  }

  private report(): void {
    if (this.reported) return;
    this.reported = true;
    this.onReport({ restored: this.restored, unresolved: this.unresolved });
  }

  private text(text: string): string {
    if (this.structured) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const r = restoreValue(parsed, this.session, this.declaredTypes);
        this.count(r);
        return r.restored > 0 ? JSON.stringify(r.value) : text;
      }
    }
    const r = restoreText(text, this.session, this.declaredTypes);
    this.count(r);
    return r.text;
  }

  private toolCall(call: LlmToolCall): LlmToolCall {
    const r = restoreValue(call.arguments, this.session, this.declaredTypes);
    this.count(r);
    return { ...call, arguments: isRecord(r.value) ? r.value : call.arguments };
  }

  /** A structured stream: text held whole, restored as JSON before anything that follows it. */
  private async *structuredStream(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    let held = '';
    const release = (): StreamChunk | null => {
      if (held === '') return null;
      const out: StreamChunk = { type: 'text', content: this.text(held) };
      held = '';
      return out;
    };
    try {
      for await (const chunk of source) {
        if (chunk.type === 'text') {
          held += chunk.content;
          continue;
        }
        const text = release();
        if (text) yield text;
        yield chunk.type === 'tool_call'
          ? { type: 'tool_call', toolCall: this.toolCall(chunk.toolCall) }
          : chunk;
      }
      const text = release();
      if (text) yield text;
    } finally {
      this.report();
    }
  }

  /** A whole response. */
  response(response: LlmResponse): LlmResponse {
    const out: LlmResponse = {
      ...response,
      content: this.text(response.content),
      ...(response.toolCalls ? { toolCalls: response.toolCalls.map((c) => this.toolCall(c)) } : {}),
    };
    this.report();
    return out;
  }

  /**
   * A stream, chunk by chunk. A structured reply (`responseFormat`) is held
   * whole and restored as JSON at its end, since a value restored into a
   * streamed JSON string could carry a quote or a newline that breaks it.
   */
  async *stream(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    if (this.structured) {
      yield* this.structuredStream(source);
      return;
    }
    const text = new StreamRestorer(this.session, this.declaredTypes);
    const reasoning = new StreamRestorer(this.session, this.declaredTypes);
    const flushText = (): StreamChunk | null => {
      const out = text.flush();
      return out ? { type: 'text', content: out } : null;
    };
    const flushReasoning = (): StreamChunk | null => {
      const out = reasoning.flush();
      return out ? { type: 'reasoning', text: out } : null;
    };
    try {
      for await (const chunk of source) {
        if (chunk.type === 'text') {
          const held = flushReasoning();
          if (held) yield held;
          const out = text.push(chunk.content);
          if (out) yield { type: 'text', content: out };
          continue;
        }
        if (chunk.type === 'reasoning') {
          const held = flushText();
          if (held) yield held;
          const out = reasoning.push(chunk.text);
          if (out) yield { type: 'reasoning', text: out };
          continue;
        }
        // Anything else ends what was held: release it first, in order.
        const heldText = flushText();
        if (heldText) yield heldText;
        const heldReasoning = flushReasoning();
        if (heldReasoning) yield heldReasoning;
        yield chunk.type === 'tool_call'
          ? { type: 'tool_call', toolCall: this.toolCall(chunk.toolCall) }
          : chunk;
      }
      // A stream that ended without a `done` chunk still owes what it held.
      const heldText = flushText();
      if (heldText) yield heldText;
      const heldReasoning = flushReasoning();
      if (heldReasoning) yield heldReasoning;
    } finally {
      this.restored += text.restored + reasoning.restored;
      this.unresolved += text.unresolved.length + reasoning.unresolved.length;
      this.report();
    }
  }
}
