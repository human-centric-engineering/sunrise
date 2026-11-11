/**
 * Replacing detected values with placeholders (§127).
 *
 * `maskText()` takes the spans the detectors found and swaps each for its
 * session's placeholder. Two things it adds:
 *
 * - **Overlapping spans are merged, never dropped.** The runner hands over
 *   merged spans already; a caller that does not is still safe, because a
 *   dropped overlap is text that goes out unmasked.
 * - **Text that already looks like a placeholder is masked too**, as a
 *   `LITERAL`. Otherwise a user who typed "PERSON_1", or a document that
 *   contains it, would have it restored into somebody's name on the way back.
 *   With it masked, restoring gives back exactly what was written:
 *   `restoreText(maskText(x).text) === x`.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import {
  CORE_ENTITY_TYPES,
  type EntityType,
  type TokenSession,
} from '@/lib/privacy/adapters/types';
import { placeholderPattern } from '@/lib/privacy/pii/placeholder-grammar';
import { allMatches } from '@/lib/privacy/pii/text';
import { LITERAL_TYPE } from '@/lib/privacy/pii/token-strategy';

/**
 * The line the stage adds to the system prompt when masking is active. Short,
 * because it is sent on every call.
 */
export const PLACEHOLDER_INSTRUCTION =
  'Some names and details in this conversation are replaced by placeholders such as [PERSON_1]. ' +
  'Treat each as the thing it stands for, and when you refer to one, copy the placeholder exactly.';

export interface MaskSpan {
  type: EntityType;
  start: number;
  end: number;
}

export interface MaskOptions {
  /**
   * Mask text that already looks like a placeholder (default true). That only
   * protects a restore, so a mode that never restores (`redact`) passes false
   * and leaves the user's own text, a template's "[PERSON_2]" say, alone.
   */
  escapeLookAlikes?: boolean;
}

export interface MaskResult {
  text: string;
  /** How many detected spans were replaced, by type. */
  counts: Record<string, number>;
  /**
   * How many look-alikes were masked as `LITERAL`. Kept apart from `counts`:
   * they are not detections, and per-type counts must not report them as one.
   */
  literals: number;
}

/**
 * Sort and merge overlapping spans. A safety net for a caller that has not
 * merged: overlaps are joined so none of their text is left out, and the
 * first span's type names the join. The runner's own merge
 * (`resolveOverlaps()`) chooses types by confidence, which `MaskSpan` does not
 * carry, so callers should pass its output.
 */
function merged(spans: readonly MaskSpan[]): MaskSpan[] {
  const out: MaskSpan[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * `spans`, plus every piece of the remaining text that restoring would read as
 * a placeholder, as a `LITERAL`.
 *
 * The remaining text is searched piece by piece — the stretches between
 * spans — each on its own, because in the output each piece sits between
 * placeholders, whose brackets end a word. So a span that cuts through
 * "[LITERAL_1]" leaves "[LITERAL_1" to be caught, and "PERSON_1x" with "x"
 * detected, which becomes "PERSON_1[ORG_1]", is caught too.
 *
 * One pass is enough: masking a look-alike cannot make another. A look-alike
 * begins after a non-word character and ends at a word boundary, so the text
 * either side of one already had a boundary there, and the search saw it.
 * The round-trip property test runs this over generated inputs.
 */
function withLookAlikes(text: string, spans: MaskSpan[], types: Iterable<string>): MaskSpan[] {
  const pattern = placeholderPattern([...types, LITERAL_TYPE]);
  const found: MaskSpan[] = [];
  let at = 0;
  for (const s of [...spans, { type: LITERAL_TYPE, start: text.length, end: text.length }]) {
    const piece = text.slice(at, s.start);
    for (const m of allMatches(pattern, piece, true)) {
      found.push({ type: LITERAL_TYPE, start: at + m.index, end: at + m.index + m[0].length });
    }
    at = s.end;
  }
  return merged([...spans, ...found]);
}

/**
 * Replace every span in `text` with its placeholder from `session`.
 *
 * `declaredTypes` is every type the registered detectors may report
 * (`getPrivacyAdapters().detectors`). Required, because leaving it out fails
 * silently: a look-alike of a fork's own type would go unmasked in a message
 * masked before the first real value of that type, so "US_SSN_1" typed early
 * would be restored into the SSN a later message supplied. Core's types are
 * always included; pass `[]` only when no detector declares more.
 */
export function maskText(
  text: string,
  spans: readonly MaskSpan[],
  session: TokenSession,
  declaredTypes: Iterable<EntityType>,
  options: MaskOptions = {}
): MaskResult {
  const detected = merged(spans.filter((s) => s.start < s.end));
  const types = new Set<string>([
    ...CORE_ENTITY_TYPES,
    ...declaredTypes,
    // Every type the session issued is a declared one, so its entries need
    // not be copied per message to find them.
    ...detected.map((s) => s.type),
  ]);
  const all = options.escapeLookAlikes === false ? detected : withLookAlikes(text, detected, types);
  const counts: Record<string, number> = {};
  let literals = 0;
  let out = '';
  let at = 0;
  for (const s of all) {
    out += text.slice(at, s.start);
    out += session.placeholderFor(s.type, text.slice(s.start, s.end));
    if (s.type === LITERAL_TYPE) literals++;
    else counts[s.type] = (counts[s.type] ?? 0) + 1;
    at = s.end;
  }
  out += text.slice(at);
  return { text: out, counts, literals };
}
