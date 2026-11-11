/**
 * Finding phone numbers in text, for tiers A and B (§127).
 *
 * `libphonenumber-js` with its full metadata does the parsing. It finds
 * numbers it considers *valid* — allocated ranges — and nothing else, so a
 * number in a reserved or unallocated range (Ofcom's drama range, 07700
 * 900xxx, is the common one) is found here by a phone-shaped pattern and
 * checked as *possible*: the right length for its country.
 *
 * National numbers are read as UK; international ones by their prefix.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Detection*
 */
import { findPhoneNumbersInText, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { allMatches, overlapsAny } from '@/lib/privacy/pii/text';

export interface PhoneCandidate {
  start: number;
  end: number;
  /** The number in E.164, for comparing two spellings of one number. */
  e164: string;
  /** True for an allocated range; false for one that is only the right length. */
  valid: boolean;
}

/**
 * A run of digits, spaces, brackets and dashes, optionally after a `+` or an
 * opening bracket ("(07700) 900184").
 */
const PHONE_SHAPED = /(?<![\d+(])(?:\+|\()?\d[\d ()-]{7,40}\d(?!\d)/g;

/** The fewest digits a phone number in text has. */
const MIN_DIGITS = 9;

/** Every phone number in `text`, valid ones first. */
export function phoneCandidates(text: string): PhoneCandidate[] {
  const out: PhoneCandidate[] = findPhoneNumbersInText(text, { defaultCountry: 'GB' }).map((m) => ({
    start: m.startsAt,
    end: m.endsAt,
    e164: m.number.number,
    valid: true,
  }));
  const valid = [...out];
  for (const m of allMatches(PHONE_SHAPED, text)) {
    out.push(...possibleInRun(text, m.index, m[0], valid));
  }
  return out;
}

/**
 * The possible numbers in one phone-shaped run. The pattern allows spaces, so
 * two numbers written one after the other ("07700 900123 07700 900456") are
 * one run, and the run as a whole is no number at all. The run is split at
 * its spaces and read left to right, taking at each group the longest
 * stretch of groups that is a possible number and overlaps no valid one.
 */
function possibleInRun(
  text: string,
  runStart: number,
  run: string,
  valid: readonly PhoneCandidate[]
): PhoneCandidate[] {
  const groups = allMatches(/[^ ]+/g, run).map((g) => ({
    start: runStart + g.index,
    end: runStart + g.index + g[0].length,
  }));
  const out: PhoneCandidate[] = [];
  let i = 0;
  while (i < groups.length) {
    let taken = -1;
    for (let j = groups.length - 1; j >= i; j--) {
      const start = groups[i].start;
      const end = groups[j].end;
      const candidate = text.slice(start, end);
      if ((candidate.match(/\d/g) ?? []).length < MIN_DIGITS) break;
      if (overlapsAny(start, end, valid)) continue;
      const parsed = parsePhoneNumberFromString(candidate, 'GB');
      if (parsed?.isPossible()) {
        out.push({ start, end, e164: parsed.number, valid: false });
        taken = j;
        break;
      }
    }
    i = taken === -1 ? i + 1 : taken + 1;
  }
  return out;
}

/**
 * A pattern for one known phone number however it is written: national
 * ("07700 900515", "(07700) 900515") or international ("+44 7700 900515",
 * "0044 (0)7700-900515"), with any spaces, dots, dashes or brackets between
 * its digits. Matching the number's own digits needs no parse of the text,
 * which tier A has already paid for.
 */
export function phoneDigitsPattern(e164: string): RegExp | null {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return null;
  const sep = '[\\s().-]*';
  const digits = (d: string) => [...d].join(sep);
  const national = digits(parsed.nationalNumber);
  const international = `(?:\\+|00)${sep}${digits(parsed.countryCallingCode)}${sep}(?:\\(0\\)${sep})?`;
  return new RegExp(`(?<![\\d+])(?:${international}|\\(?0${sep})?${national}(?!\\d)`, 'g');
}

/** `value` as E.164, or null when it is not a possible phone number. */
export function toE164(value: string): string | null {
  const parsed = parsePhoneNumberFromString(value, 'GB');
  return parsed?.isPossible() ? parsed.number : null;
}
