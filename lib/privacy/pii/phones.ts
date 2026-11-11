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
const PHONE_SHAPED = /(?<![\d+(])(?:\+|\()?\d[\d ()-]{7,18}\d(?!\d)/g;

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
    const end = m.index + m[0].length;
    if (overlapsAny(m.index, end, valid)) continue;
    const parsed = parsePhoneNumberFromString(m[0], 'GB');
    if (parsed?.isPossible()) {
      out.push({ start: m.index, end, e164: parsed.number, valid: false });
    }
  }
  return out;
}

/** `value` as E.164, or null when it is not a possible phone number. */
export function toE164(value: string): string | null {
  const parsed = parsePhoneNumberFromString(value, 'GB');
  return parsed?.isPossible() ? parsed.number : null;
}
