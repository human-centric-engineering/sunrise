/**
 * Restoring a streamed reply, chunk by chunk (§127).
 *
 * A placeholder can arrive split across chunks: `[PER` in one, `SON_1]` in
 * the next. Restoring each chunk on its own would leave both halves as
 * written. So the restorer holds back the end of the text it has seen
 * whenever that end could still become a placeholder, and emits it once the
 * next chunk settles the question, or at `flush()`.
 *
 * What is held back is short — at most the longest placeholder — so a reader
 * sees text with no more delay than one placeholder's worth of characters.
 * The output, joined, is exactly what `restoreText()` gives for the whole
 * text, however it was split.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import type { EntityType, TokenSession } from '@/lib/privacy/adapters/types';
import { restoreAfter, sessionPattern } from '@/lib/privacy/pii/restore';
import { TYPE_CHAR, TYPE_FIRST_CHAR, WORD_CHAR } from '@/lib/privacy/pii/placeholder-grammar';
import { escapeRegExp } from '@/lib/privacy/pii/text';
import { PLACEHOLDER_FORMAT } from '@/lib/privacy/pii/token-strategy';

/**
 * The end of a text that could still grow into a placeholder: an opening
 * bracket, then a run of capitals, digits and underscores starting a word.
 * Also a complete one, which a closing bracket or more digits may follow.
 */
const OPEN = escapeRegExp(PLACEHOLDER_FORMAT.open);
const PENDING_TAIL = new RegExp(
  `(?:${OPEN}|(?<!${WORD_CHAR}))${TYPE_FIRST_CHAR}${TYPE_CHAR}*$|${OPEN}$`
);

/** Longer than any placeholder: a run past this is not one, and is released. */
const MAX_HOLD = 64;

export class StreamRestorer {
  private pending = '';
  /**
   * The last character already emitted, unrestored. The placeholder grammar
   * needs a word boundary before a placeholder, and a segment restored on its
   * own cannot see what came before it: "xP" then "ERSON_1" must stay as
   * written, as "xPERSON_1" would.
   */
  private before = '';
  private restoredCount = 0;
  private readonly unresolvedList: string[] = [];

  /** Built once: masking is finished before the reply streams. */
  private readonly pattern: RegExp;

  constructor(
    private readonly session: TokenSession,
    declaredTypes: Iterable<EntityType> = []
  ) {
    this.pattern = sessionPattern(session, declaredTypes);
  }

  /** Add a chunk; returns the restored text that is now safe to emit. */
  push(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = text.slice(this.holdFrom(text));
    return this.emit(text.slice(0, text.length - this.pending.length));
  }

  /** The end of the stream: restore and emit whatever was held back. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return this.emit(rest);
  }

  get restored(): number {
    return this.restoredCount;
  }

  /** Placeholder-shaped text the session never issued, left as written. */
  get unresolved(): readonly string[] {
    return [...this.unresolvedList];
  }

  /**
   * Where the part of `text` that might still become a placeholder starts,
   * or `text.length` when none might. Only the last MAX_HOLD characters are
   * looked at, plus one for the boundary before them, so each chunk costs
   * the same however long the stream has run.
   */
  private holdFrom(text: string): number {
    const probe = (this.before + text).slice(-(MAX_HOLD + 1));
    const offset = this.before.length + text.length - probe.length;
    const tail = PENDING_TAIL.exec(probe);
    // A run reaching the start of a cut-down probe is longer than any
    // placeholder, and is released.
    const truncated = offset > 0;
    if (!tail || (truncated && tail.index === 0)) return text.length;
    // A run that began in text already emitted continues a word, so it cannot
    // start a placeholder: release it rather than hold it.
    if (offset + tail.index < this.before.length) return text.length;
    const from = offset + tail.index - this.before.length;
    // At most MAX_HOLD characters: a longer run is not a placeholder.
    return text.length - from > MAX_HOLD ? text.length : from;
  }

  private emit(segment: string): string {
    if (segment === '') return '';
    const r = restoreAfter(this.before, segment, this.session, this.pattern);
    this.before = segment[segment.length - 1];
    this.restoredCount += r.restored;
    this.unresolvedList.push(...r.unresolved);
    return r.text;
  }
}
