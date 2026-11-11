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
import { COMMON_WORDS, isFirstName, ORG_SUFFIXES, TITLES } from '@/lib/privacy/pii/lexicon';
import { phoneDigitsPattern, toE164 } from '@/lib/privacy/pii/phones';
import { allMatches, createYielder, escapeRegExp, span } from '@/lib/privacy/pii/text';

export const KNOWN_VALUES_DETECTOR_ID = 'core.known-values';

/** Exact matches of a known value. */
export const KNOWN_VALUE_CONFIDENCE = 0.98;
/** A variant: a first or last name alone, an initial, a reordered name. */
export const VARIANT_CONFIDENCE = 0.9;

/** Shorter values match too much ordinary text to be worth matching. */
const MIN_LENGTH = 3;

/** What this tier may report: every core type. */
const DECLARED: readonly string[] = CORE_ENTITY_TYPES;

/** The words of a literal, lower case: every one must appear for it to match. */
function needlesFor(...literals: string[]): string[] {
  return literals.flatMap((l) => l.trim().toLowerCase().split(/\s+/)).filter((w) => w !== '');
}

/**
 * A pattern for `literal`, with any run of whitespace standing for any other,
 * case-insensitive unless `caseSensitive`.
 *
 * No word-boundary lookarounds and no `u` flag: those made each pattern
 * expensive to compile, and a call compiles several per known value. The
 * search checks "a whole word, not inside a longer one" itself, against the
 * text (NeedleSearch).
 */
function wordPattern(literal: string, caseSensitive = false): RegExp {
  const body = literal.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(body, caseSensitive ? 'g' : 'gi');
}

interface Variant {
  pattern: RegExp;
  confidence: number;
  /**
   * Lower-case words the text must contain for the pattern to match. The
   * search runs the pattern only around the rarest of them (see
   * NeedleSearch), and not at all when one is missing.
   */
  needles: string[];
}

/** The value itself, matched as a whole word, ignoring case. */
function exact(literal: string): Variant {
  return {
    pattern: wordPattern(literal),
    confidence: KNOWN_VALUE_CONFIDENCE,
    needles: needlesFor(literal),
  };
}

/** Another form of the value, matched the same way. */
function variant(literal: string): Variant {
  return {
    pattern: wordPattern(literal),
    confidence: VARIANT_CONFIDENCE,
    needles: needlesFor(literal),
  };
}

/**
 * The forms a person's name is written in. A part that is also an ordinary
 * word ("Will", "May") is matched only capitalised, so the user called Will
 * Hart does not have every "will" in the conversation masked.
 */
/** Words around a name that are not the name: "Dr. Jane Hart Jr." is Jane Hart. */
const NAME_SUFFIXES: ReadonlySet<string> = new Set([
  'jr',
  'jnr',
  'sr',
  'snr',
  'ii',
  'iii',
  'iv',
  'phd',
  'md',
  'esq',
  'obe',
  'mbe',
  'cbe',
  'kc',
  'qc',
]);
const bare = (word: string) => word.replace(/[.,]+$/, '').toLowerCase();

function personVariants(value: string): Variant[] {
  let parts = value.trim().split(/\s+/);
  while (parts.length > 1 && TITLES.has(bare(parts[0]))) parts = parts.slice(1);
  while (parts.length > 1 && NAME_SUFFIXES.has(bare(parts[parts.length - 1]))) {
    parts = parts.slice(0, -1);
  }
  parts = parts.map((p) => p.replace(/,$/, ''));
  const out: Variant[] = [exact(value)];
  if (parts.length < 2) return out;
  const first = parts[0];
  const last = parts[parts.length - 1];
  for (const part of new Set([first, last])) {
    if (part.length < MIN_LENGTH) continue;
    const common = COMMON_WORDS.has(part.toLowerCase());
    out.push({
      pattern: wordPattern(part, common),
      confidence: VARIANT_CONFIDENCE,
      needles: needlesFor(part),
    });
  }
  const initial = escapeRegExp(first[0]);
  const surname = escapeRegExp(last);
  // A first name that is also a word is matched capitalised here too:
  // "Hart may call" is not "May Hart" written surname first.
  const reorderedFlags = COMMON_WORDS.has(first.toLowerCase()) ? 'g' : 'gi';
  const needles = needlesFor(first, last);
  out.push(
    {
      // "J. Hart", "J Hart"
      pattern: new RegExp(`${initial}\\.?\\s+${surname}`, 'g'),
      confidence: VARIANT_CONFIDENCE,
      // The initial, not the first name: "J. Hart" does not contain "James".
      needles: needlesFor(last),
    },
    {
      // "Zhang Wei" for "Wei Zhang": surname first, as many names are written.
      pattern: new RegExp(`${surname}\\s+${escapeRegExp(first)}`, reorderedFlags),
      confidence: VARIANT_CONFIDENCE,
      needles,
    },
    {
      // "Hart, James"
      pattern: new RegExp(`${surname},\\s*${escapeRegExp(first)}`, reorderedFlags),
      confidence: VARIANT_CONFIDENCE,
      needles,
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
  const out: Variant[] = [exact(value)];
  const parts = value
    .trim()
    .replace(/[.,]+$/, '')
    .split(/\s+/);
  const lastPart = parts[parts.length - 1].replace(/\./g, '').toLowerCase();
  const hasSuffix = parts.length > 1 && ORG_SUFFIXES.has(lastPart);
  const nameParts = hasSuffix ? parts.slice(0, -1) : parts;
  const base = nameParts.join(' ');
  if (hasSuffix && base.length >= MIN_LENGTH) {
    // One word without its suffix is matched capitalised only: "Next PLC"
    // without "PLC" is also the word "next", and a company's short name is
    // written capitalised.
    const oneWord = nameParts.length === 1;
    out.push(oneWord ? { ...variant(base), pattern: wordPattern(base, true) } : variant(base));
  }
  const head = nameParts[0];
  const headLower = head.toLowerCase();
  if (
    nameParts.length > 1 &&
    head.length >= 4 &&
    !COMMON_WORDS.has(headLower) &&
    !isFirstName(headLower)
  ) {
    out.push({ ...variant(head), pattern: wordPattern(head, true) });
  }
  return out;
}

function variantsFor(known: KnownValue): Variant[] {
  if (known.type === 'PERSON') return personVariants(known.value);
  if (known.type === 'ORG') return orgVariants(known.value);
  return [exact(known.value)];
}

/**
 * Known phone numbers however they are written, so "+44 7700 900123" finds
 * "07700900123": each number's own digits, with any separators between them.
 */
function knownPhones(text: string, phones: ReadonlySet<string>): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const e164 of phones) {
    const pattern = phoneDigitsPattern(e164);
    if (!pattern) continue;
    for (const m of allMatches(pattern, text)) {
      out.push(span('PHONE', m.index, m.index + m[0].length, KNOWN_VALUE_CONFIDENCE));
    }
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
  const search = new NeedleSearch(text);
  // Two known people called James share the "James" variant: run it once.
  const ran = new Set<string>();
  for (const known of knownValues) {
    const type: EntityType = known.type;
    const value = known.value.trim();
    if (!DECLARED.includes(type) || value.length < MIN_LENGTH) continue;
    if (type === 'PHONE') {
      const e164 = toE164(value);
      if (e164) phones.add(e164);
    }
    for (const { pattern, confidence, needles } of variantsFor({ type, value })) {
      const key = `${type}|${confidence}|${pattern.flags}|${pattern.source}`;
      if (ran.has(key)) continue;
      ran.add(key);
      for (const [start, end] of search.matches(pattern, needles, value.length)) {
        out.push(span(type, start, end, confidence));
      }
    }
  }
  out.push(...knownPhones(text, phones));
  return out;
}

const WORD = /[\p{L}\p{N}]+/gu;
const PLAIN_WORD = /^[\p{L}\p{N}]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Room either side of a needle for the rest of a variant, and its spacing. */
const WINDOW_SLACK = 64;

/**
 * Runs a variant's pattern only where it can match: around the occurrences
 * of its needle. Running every pattern of every known value over the whole
 * text cost (values × variants × text length); this costs one pass to index
 * the text's words, then work proportional to where the values actually
 * occur.
 */
class NeedleSearch {
  private readonly lower: string;
  private readonly words: ReadonlySet<string>;
  private readonly positions = new Map<string, number[]>();

  /**
   * True when lower-casing changed the text's length ("İ" becomes two code
   * units): positions in `lower` are then not positions in `text`, so every
   * search runs over the whole text instead of around its needle.
   */
  private readonly drifted: boolean;

  constructor(private readonly text: string) {
    this.lower = text.toLowerCase();
    this.drifted = this.lower.length !== text.length;
    this.words = new Set(allMatches(WORD, this.lower).map((m) => m[0]));
  }

  /**
   * Every match of `pattern` in the text, as `[start, end]`, given words every
   * match contains. The pattern runs only around the rarest of them.
   */
  matches(pattern: RegExp, needles: readonly string[], literalLength: number): [number, number][] {
    if (!needles.every((n) => this.present(n))) return [];
    const needle = needles.reduce((a, b) =>
      this.occurrences(b).length < this.occurrences(a).length ? b : a
    );
    const reach = literalLength + WINDOW_SLACK;
    const occurrences = this.occurrences(needle);
    // Around each occurrence of the rarest word; or the whole text in one
    // pass, when the windows would cover more than it.
    const ranges: [number, number][] =
      this.drifted || occurrences.length * (2 * reach + needle.length) >= this.text.length
        ? [[0, this.text.length]]
        : occurrences.map((at) => [
            Math.max(0, at - reach),
            Math.min(this.text.length, at + needle.length + reach),
          ]);
    // Compiled once and reused for every range.
    const re = new RegExp(pattern.source, pattern.flags);
    const seen = new Set<number>();
    const out: [number, number][] = [];
    for (const [from, to] of ranges) {
      const range = this.text.slice(from, to);
      re.lastIndex = 0;
      for (let m = re.exec(range); m !== null; m = re.exec(range)) {
        const start = from + m.index;
        const end = start + m[0].length;
        // A whole word only: not inside a longer one. Checked against the
        // text, because a range can begin or end inside a word.
        if (
          m[0] === '' ||
          WORD_CHAR.test(this.text[start - 1] ?? '') ||
          WORD_CHAR.test(this.text[end] ?? '')
        ) {
          // Resume one character on, so a rejected match cannot hide a valid
          // one that overlaps it.
          re.lastIndex = m.index + 1;
          continue;
        }
        if (seen.has(start)) continue;
        seen.add(start);
        out.push([start, end]);
      }
    }
    return out;
  }

  private present(needle: string): boolean {
    return PLAIN_WORD.test(needle) ? this.words.has(needle) : this.lower.includes(needle);
  }

  private occurrences(needle: string): number[] {
    const cached = this.positions.get(needle);
    if (cached) return cached;
    const found: number[] = [];
    for (let i = this.lower.indexOf(needle); i !== -1; i = this.lower.indexOf(needle, i + 1)) {
      found.push(i);
    }
    this.positions.set(needle, found);
    return found;
  }
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
      const maybeYield = createYielder();
      const spans = findKnownValueSpans(text, ctx.knownValues);
      await maybeYield();
      ctx.signal.throwIfAborted();
      return spans;
    },
  };
}
