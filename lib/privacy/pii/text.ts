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
 * call into the next — unless `owned`: a global pattern the caller built for
 * this one job (a restore, a mask) runs as it is, saving a compile per call,
 * and is left with `lastIndex` 0. Never pass `owned` for a shared pattern.
 */
export function allMatches(pattern: RegExp, text: string, owned = false): RegExpExecArray[] {
  const re =
    owned && pattern.global
      ? pattern
      : new RegExp(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
        );
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    // An empty match would otherwise loop forever.
    if (m[0] === '') re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

/**
 * Give the event loop a turn. Detection is synchronous work, and the runner
 * enforces each detector's timeout with a timer; a timer cannot fire while
 * synchronous work runs. Awaiting this after each piece of work lets an
 * expired timeout fire and abort the signal, so the next `throwIfAborted()`
 * reports the overrun instead of the late result counting as a success.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A yield that only yields once `sliceMs` of work has passed since the last
 * one. A `setTimeout(0)` waits at least a millisecond, so yielding after every
 * small piece of work adds idle time to every call; yielding by elapsed time
 * keeps the timeout enforceable without that cost.
 */
export function createYielder(sliceMs = 20): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < sliceMs) return;
    await yieldToEventLoop();
    last = performance.now();
  };
}

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A test for "is [start, end) wholly inside text `spans` cover?", answered in
 * logarithmic time: the spans are merged into sorted, disjoint intervals
 * once. Checking every candidate against every span instead is quadratic
 * when both grow with the text.
 */
export function coverage(
  spans: readonly { start: number; end: number }[]
): (start: number, end: number) => boolean {
  const merged: { start: number; end: number }[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  return (start, end) => {
    let lo = 0;
    let hi = merged.length - 1;
    // The last interval starting at or before `start`.
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid].start <= start) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi >= 0 && end <= merged[hi].end;
  };
}

/** Whether [start, end) overlaps any of `spans`. */
export function overlapsAny(
  start: number,
  end: number,
  spans: readonly { start: number; end: number }[]
): boolean {
  return spans.some((s) => s.start < end && start < s.end);
}
