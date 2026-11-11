/**
 * Checksum and structure checks for the identifiers tier A recognises (§127).
 *
 * Each function takes the identifier with separators already removed and
 * answers one question: could this be a real one? A pattern alone matches any
 * run of the right shape; the check is what lets a recogniser report a match
 * with full confidence, and what keeps a random number of the right length
 * from being reported at all.
 *
 * Pure functions over strings, no state.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Detection*
 */

function digitsOnly(value: string, length?: number): number[] | null {
  if (!/^\d+$/.test(value)) return null;
  if (length !== undefined && value.length !== length) return null;
  return [...value].map(Number);
}

/**
 * NHS number (England, Wales, Isle of Man): ten digits, the last a modulus 11
 * check digit over the first nine weighted 10 down to 2. A remainder giving
 * 10 means the number was never issued.
 */
export function isValidNhsNumber(value: string): boolean {
  const d = digitsOnly(value, 10);
  if (!d) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === d[9];
}

/** The Luhn check every payment card number carries. */
export function passesLuhn(value: string): boolean {
  const d = digitsOnly(value);
  if (!d || d.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d[d.length - 1 - i];
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Issuer prefixes of the card schemes in use, by length. A Luhn-valid number
 * outside these is far more likely an order or account reference than a card.
 */
const CARD_PREFIXES: readonly { prefix: RegExp; lengths: readonly number[] }[] = [
  { prefix: /^4/, lengths: [13, 16, 19] }, // Visa
  { prefix: /^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] }, // Mastercard
  { prefix: /^3[47]/, lengths: [15] }, // American Express
  { prefix: /^(?:6011|65|64[4-9]|622)/, lengths: [16, 19] }, // Discover / UnionPay
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 19] }, // JCB
  { prefix: /^3(?:0[0-5]|[68])/, lengths: [14, 16, 19] }, // Diners Club
  { prefix: /^(?:5018|5020|5038|56|57|58|6304|67)/, lengths: [12, 13, 14, 15, 16, 17, 18, 19] }, // Maestro
];

/** A payment card number: a scheme's prefix and length, and the Luhn check. */
export function isValidCardNumber(value: string): boolean {
  if (!/^\d{12,19}$/.test(value)) return false;
  const scheme = CARD_PREFIXES.some(
    (s) => s.prefix.test(value) && s.lengths.includes(value.length)
  );
  return scheme && passesLuhn(value);
}

/**
 * IBAN lengths by country, for the countries a UK install is most likely to
 * see. A country not listed is checked against the general bounds (15 to 34)
 * and the checksum alone.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
  AE: 23,
  SA: 24,
  IL: 23,
};

/**
 * IBAN: country code, two check digits, then the account. Valid when moving
 * the first four characters to the end and reading letters as 10–35 leaves a
 * number whose remainder mod 97 is 1 (ISO 13616).
 */
export function isValidIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  const expected = IBAN_LENGTHS[value.slice(0, 2)];
  if (expected !== undefined && value.length !== expected) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const n = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    // One or two digits at a time keeps the running value far below 2^53.
    remainder = (remainder * (n > 9 ? 100 : 10) + n) % 97;
  }
  return remainder === 1;
}

/**
 * Prefixes HMRC has never issued, or reserves: administrative, temporary and
 * the documentation examples.
 */
const NINO_UNUSED_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

/**
 * National Insurance number: two letters, six digits, an optional A–D suffix.
 * There is no check digit; the letter rules are the check. D, F, I, Q, U and
 * V are never used, O never second, and a handful of prefixes never issued.
 */
export function isValidNino(value: string): boolean {
  const m = /^([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])\d{6}[A-D]?$/.exec(value);
  return m !== null && !NINO_UNUSED_PREFIXES.has(m[1]);
}

/**
 * UK VAT registration number: nine digits (a twelve-digit branch number
 * starts with the same nine). The first seven are weighted 8 down to 2 and
 * added to the last two read as a number; the total is a multiple of 97 for
 * the older series, or becomes one after adding 55 for numbers issued since
 * 2010.
 */
export function isValidUkVat(value: string): boolean {
  const d = digitsOnly(value);
  if (!d || (d.length !== 9 && d.length !== 12)) return false;
  let total = 0;
  for (let i = 0; i < 7; i++) total += d[i] * (8 - i);
  total += d[7] * 10 + d[8];
  return total % 97 === 0 || (total + 55) % 97 === 0;
}

/**
 * The date encoded in a UK driving licence number's digits: a month of 01–12
 * (51–62 for a woman's licence) and a day of 01–31. A run of the right shape
 * whose digits cannot be a date is not a licence number.
 */
export function isPlausibleUkDrivingLicence(value: string): boolean {
  const m = /^[A-Z9]{5}(\d)(\d{2})(\d{2})(\d)[A-Z9]{2}\d[A-Z]{2}$/.exec(value);
  if (!m) return false;
  const month = Number(m[2]) % 50;
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
