/**
 * Small text helpers the detection tiers share (§127).
 *
 * Every offset here is a UTF-16 code-unit index, the unit `String.slice` and
 * `RegExp` use, which is what the span contract requires.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Spans*
 */
import type { DetectedSpan, EntityType } from '@/lib/privacy/adapters/types';

export function span(
  type: EntityType,
  start: number,
  end: number,
  confidence: number
): DetectedSpan {
  return { type, start, end, confidence };
}

/**
 * Whether `pattern` matches within `window` characters before `start`.
 * Context words ("passport", "sort code", "born") turn an ambiguous run of
 * digits into an identifier; they nearly always come before the value.
 */
export function hasContextBefore(
  text: string,
  start: number,
  pattern: RegExp,
  window = 40
): boolean {
  return pattern.test(text.slice(Math.max(0, start - window), start));
}

/**
 * Every match of `pattern` in `text`, each with its index. Runs on a copy of
 * the pattern, so a shared global RegExp's `lastIndex` never carries from one
 * call into the next.
 */
export function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  );
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    // An empty match would otherwise loop forever.
    if (m[0] === '') re.lastIndex++;
  }
  return out;
}

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether [start, end) overlaps any of `spans`. */
export function overlapsAny(
  start: number,
  end: number,
  spans: readonly { start: number; end: number }[]
): boolean {
  return spans.some((s) => s.start < end && start < s.end);
}
