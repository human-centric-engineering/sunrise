/**
 * Tier B — values the layer already knows belong to someone in the call
 * (§127).
 *
 * The stage passes them in `ctx.knownValues`: the user's own details, their
 * memory values, an inbound sender's address, the org's protected terms. This
 * tier only matches them; gathering them is the stage's job. A known value is
 * the strongest signal there is short of a checksum, so it reports just below
 * 1, and the variants people actually write — a first name alone, an initial
 * and surname, a phone number spaced differently — just below that.
 *
 * A known value whose type this tier does not declare is skipped rather than
 * reported: an undeclared type would make the registry reject the whole
 * result, and a required core detector failing refuses the call.
 *
 * Reached only through the registry (`core-defaults.ts`).
 *
 * @see .context/privacy/llm-privacy-layer.md — *Detection*
 */
import {
  CORE_ENTITY_TYPES,
  type DetectedSpan,
  type EntityType,
  type KnownValue,
  type PrivacyDetector,
} from '@/lib/privacy/adapters/types';
import { COMMON_WORDS, isFirstName, ORG_SUFFIXES } from '@/lib/privacy/pii/lexicon';
import { phoneCandidates, toE164 } from '@/lib/privacy/pii/phones';
import { allMatches, escapeRegExp, span, yieldToEventLoop } from '@/lib/privacy/pii/text';

export const KNOWN_VALUES_DETECTOR_ID = 'core.known-values';

/** Exact matches of a known value. */
export const KNOWN_VALUE_CONFIDENCE = 0.98;
/** A variant: a first or last name alone, an initial, a reordered name. */
export const VARIANT_CONFIDENCE = 0.9;

/** Shorter values match too much ordinary text to be worth matching. */
const MIN_LENGTH = 3;

/** What this tier may report: every core type. */
const DECLARED: readonly string[] = CORE_ENTITY_TYPES;

/**
 * A pattern for `literal` as a whole word: not inside a longer word, with any
 * run of whitespace standing for any other, and case-insensitive unless
 * `caseSensitive`.
 */
function wordPattern(literal: string, caseSensitive = false): RegExp {
  const body = literal.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, caseSensitive ? 'gu' : 'giu');
}

interface Variant {
  pattern: RegExp;
  confidence: number;
}

/**
 * The forms a person's name is written in. A part that is also an ordinary
 * word ("Will", "May") is matched only capitalised, so the user called Will
 * Hart does not have every "will" in the conversation masked.
 */
function personVariants(value: string): Variant[] {
  const parts = value.trim().split(/\s+/);
  const out: Variant[] = [{ pattern: wordPattern(value), confidence: KNOWN_VALUE_CONFIDENCE }];
  if (parts.length < 2) return out;
  const first = parts[0];
  const last = parts[parts.length - 1];
  for (const part of new Set([first, last])) {
    if (part.length < MIN_LENGTH) continue;
    const common = COMMON_WORDS.has(part.toLowerCase());
    out.push({ pattern: wordPattern(part, common), confidence: VARIANT_CONFIDENCE });
  }
  const initial = escapeRegExp(first[0]);
  const surname = escapeRegExp(last);
  out.push(
    {
      // "J. Hart", "J Hart"
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])${initial}\\.?\\s+${surname}(?![\\p{L}\\p{N}])`,
        'gu'
      ),
      confidence: VARIANT_CONFIDENCE,
    },
    {
      // "Zhang Wei" for "Wei Zhang": surname first, as many names are written.
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])${surname}\\s+${escapeRegExp(first)}(?![\\p{L}\\p{N}])`,
        'giu'
      ),
      confidence: VARIANT_CONFIDENCE,
    },
    {
      // "Hart, James"
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])${surname},\\s*${escapeRegExp(first)}(?![\\p{L}\\p{N}])`,
        'giu'
      ),
      confidence: VARIANT_CONFIDENCE,
    }
  );
  return out;
}

/**
 * A company with and without its legal suffix, and by its first word
 * ("Halden Logistics Ltd" → "Halden Logistics", "Halden"). The first word is
 * matched capitalised only, and not when it is a common word or a first name.
 */
function orgVariants(value: string): Variant[] {
  const out: Variant[] = [{ pattern: wordPattern(value), confidence: KNOWN_VALUE_CONFIDENCE }];
  const parts = value
    .trim()
    .replace(/[.,]+$/, '')
    .split(/\s+/);
  const lastPart = parts[parts.length - 1].replace(/\./g, '').toLowerCase();
  const hasSuffix = parts.length > 1 && ORG_SUFFIXES.has(lastPart);
  const nameParts = hasSuffix ? parts.slice(0, -1) : parts;
  if (hasSuffix && nameParts.join(' ').length >= MIN_LENGTH) {
    out.push({ pattern: wordPattern(nameParts.join(' ')), confidence: VARIANT_CONFIDENCE });
  }
  const head = nameParts[0];
  const headLower = head.toLowerCase();
  if (
    nameParts.length > 1 &&
    head.length >= 4 &&
    !COMMON_WORDS.has(headLower) &&
    !isFirstName(headLower)
  ) {
    out.push({ pattern: wordPattern(head, true), confidence: VARIANT_CONFIDENCE });
  }
  return out;
}

function variantsFor(known: KnownValue): Variant[] {
  if (known.type === 'PERSON') return personVariants(known.value);
  if (known.type === 'ORG') return orgVariants(known.value);
  return [{ pattern: wordPattern(known.value), confidence: KNOWN_VALUE_CONFIDENCE }];
}

/**
 * Known phone numbers however they are spaced: every phone-shaped run in the
 * text is normalised and compared, so "+44 7700 900123" finds "07700900123".
 */
function knownPhones(text: string, phones: ReadonlySet<string>): DetectedSpan[] {
  if (phones.size === 0) return [];
  const out: DetectedSpan[] = [];
  for (const c of phoneCandidates(text)) {
    if (phones.has(c.e164)) out.push(span('PHONE', c.start, c.end, KNOWN_VALUE_CONFIDENCE));
  }
  return out;
}

/** Find every known value, and its variants, in `text`. */
export function findKnownValueSpans(
  text: string,
  knownValues: readonly KnownValue[]
): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  const phones = new Set<string>();
  for (const known of knownValues) {
    const type: EntityType = known.type;
    const value = known.value.trim();
    if (!DECLARED.includes(type) || value.length < MIN_LENGTH) continue;
    if (type === 'PHONE') {
      const e164 = toE164(value);
      if (e164) phones.add(e164);
    }
    for (const { pattern, confidence } of variantsFor({ type, value })) {
      for (const m of allMatches(pattern, text)) {
        out.push(span(type, m.index, m.index + m[0].length, confidence));
      }
    }
  }
  out.push(...knownPhones(text, phones));
  return out;
}

/** Tier B as a detector adapter. */
export function knownValuesDetector(): PrivacyDetector {
  return {
    id: KNOWN_VALUES_DETECTOR_ID,
    egress: 'in_process',
    entityTypes: CORE_ENTITY_TYPES,
    // Synchronous work: the turn given to the event loop after it lets an
    // expired timeout abort the signal, so an overrun rejects (see text.ts).
    detect: async ({ text }, ctx) => {
      ctx.signal.throwIfAborted();
      const spans = findKnownValueSpans(text, ctx.knownValues);
      await yieldToEventLoop();
      ctx.signal.throwIfAborted();
      return spans;
    },
  };
}
