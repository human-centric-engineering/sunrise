/**
 * Span validation and overlap resolution for the privacy layer (§127).
 *
 * Pure functions. A detector's output is untrusted: an app's adapter may wrap
 * a remote service, and a bad offset here masks the wrong text and sends the
 * real value. So a result is checked whole before any of it is used, and a
 * malformed result is a failure of that adapter, never partly trusted.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Spans* and *Overlaps*
 */
import { isRecord } from '@/lib/utils';
import {
  ENTITY_TYPE_PATTERN,
  type AttributedSpan,
  type EntityType,
} from '@/lib/privacy/adapters/types';

/** Why a detector's result was rejected. Carries no request text. */
export class MalformedSpansError extends Error {
  constructor(
    readonly adapterId: string,
    readonly reason: string
  ) {
    super(`privacy detector ${adapterId} returned a malformed result: ${reason}`);
    this.name = 'MalformedSpansError';
  }
}

/**
 * Check every span a detector returned against the text it was given, and
 * attribute them to it. Throws {@link MalformedSpansError} on the first
 * problem; the reason names an index and a field, never the text.
 *
 * A span is accepted when:
 * - `start` and `end` are integers with `0 <= start < end <= text.length`;
 * - `type` is a valid entity-type name AND one the detector declared;
 * - `confidence` is a finite number in `[0, 1]`.
 *
 * Unknown extra fields are dropped rather than rejected, so a service that
 * returns more than it is asked for still works. `learned` is kept when it
 * is exactly `true`, and dropped otherwise.
 */
export function validateSpans(
  result: unknown,
  text: string,
  adapterId: string,
  declaredTypes: ReadonlySet<EntityType>
): AttributedSpan[] {
  if (!Array.isArray(result)) {
    throw new MalformedSpansError(adapterId, 'not an array');
  }
  const spans: AttributedSpan[] = [];
  for (let i = 0; i < result.length; i++) {
    const raw: unknown = result[i];
    if (!isRecord(raw)) throw new MalformedSpansError(adapterId, `span ${i} is not an object`);
    const { type, start, end, confidence, learned } = raw;
    if (typeof type !== 'string' || !ENTITY_TYPE_PATTERN.test(type)) {
      throw new MalformedSpansError(adapterId, `span ${i} has an invalid type`);
    }
    if (!declaredTypes.has(type)) {
      throw new MalformedSpansError(
        adapterId,
        `span ${i} has type ${type}, which it did not declare`
      );
    }
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isInteger(start) ||
      !Number.isInteger(end)
    ) {
      throw new MalformedSpansError(adapterId, `span ${i} has a non-integer offset`);
    }
    if (start < 0 || end > text.length || start >= end) {
      throw new MalformedSpansError(adapterId, `span ${i} is out of range`);
    }
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new MalformedSpansError(adapterId, `span ${i} has an invalid confidence`);
    }
    // Frozen here, once: every later reader (the next detector's priorSpans,
    // the merge) gets a span nobody can change. `learned` only when exactly
    // true: anything else is a span found where it stands, which is what a
    // refusal acts on, so a malformed flag can only make placement do what
    // it did before the flag existed.
    spans.push(
      Object.freeze({
        type,
        start,
        end,
        confidence,
        source: adapterId,
        ...(learned === true ? { learned: true } : {}),
      })
    );
  }
  return spans;
}

/**
 * Merge overlapping spans into one span each, sorted by start.
 *
 * **Overlapping spans become their union**, not the winner alone. Dropping the
 * loser would leave its non-overlapping part unmasked — a leak — while masking
 * the union costs at most a few extra characters of context. The merged span
 * takes the type of its most specific member: highest confidence, then the
 * longest, then the adapter earliest in run order (`rank`, lower first — core
 * before app within each egress), then the type name, so the result never
 * depends on the order spans arrived in.
 *
 * Touching spans (`a.end === b.start`) do not overlap and stay separate.
 *
 * @param rank — each adapter id's position in run order; ids absent from it
 *   rank last.
 */
export function resolveOverlaps(
  spans: readonly AttributedSpan[],
  rank: ReadonlyMap<string, number> = new Map()
): AttributedSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: AttributedSpan[] = [];
  let group: AttributedSpan[] = [];
  let groupEnd = -1;

  const flush = () => {
    if (group.length === 0) return;
    const best = group.reduce((a, b) => (moreSpecific(b, a, rank) ? b : a));
    merged.push(
      Object.freeze({
        type: best.type,
        start: group[0].start,
        end: groupEnd,
        confidence: best.confidence,
        source: best.source,
        // Learned only if every member was: one found where it stands makes
        // the whole union a finding of that message's own.
        ...(group.every((s) => s.learned === true) ? { learned: true } : {}),
      })
    );
    group = [];
  };

  for (const span of sorted) {
    if (group.length > 0 && span.start < groupEnd) {
      group.push(span);
      groupEnd = Math.max(groupEnd, span.end);
    } else {
      flush();
      group = [span];
      groupEnd = span.end;
    }
  }
  flush();
  return merged;
}

/** Is `a` more specific than `b`? A strict, total order over distinct spans. */
function moreSpecific(
  a: AttributedSpan,
  b: AttributedSpan,
  rank: ReadonlyMap<string, number>
): boolean {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  const lenA = a.end - a.start;
  const lenB = b.end - b.start;
  if (lenA !== lenB) return lenA > lenB;
  const rankA = rank.get(a.source) ?? Number.MAX_SAFE_INTEGER;
  const rankB = rank.get(b.source) ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA < rankB;
  if (a.type !== b.type) return a.type < b.type;
  return a.start < b.start;
}
