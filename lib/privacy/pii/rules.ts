/**
 * Tier A — rule-based recognisers for identifiers with a fixed shape (§127).
 *
 * Each recogniser is a pattern plus whatever makes a match trustworthy: a
 * checksum where the identifier has one, context words where its shape alone
 * is ambiguous (nine digits are a passport number only near "passport").
 * Confidence is how specific a match is, because the overlap merge uses it to
 * choose a merged span's type: 1 for a checksum-valid match or a credential
 * with a published prefix; 0.95 for a distinctive shape, or a generic one a
 * context word confirms; 0.9 for a valid phone number, a date of birth or a
 * value assigned to a credential's name; 0.85 for a phone number that is only
 * possible. Phones sit low on purpose: the library finds a phone number in many digit runs, so a
 * UTR or NHS number that overlaps one should name the span.
 *
 * Every pattern that starts with a character class is anchored with a
 * lookbehind on that class, so a long run of matching characters is scanned
 * once, not once per starting position.
 *
 * Reached only through the registry (`core-defaults.ts`), never called
 * directly by core code; `tests/unit/lib/privacy/pii/registry-only.test.ts`
 * enforces it.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Detection*
 */
import type { DetectedSpan, EntityType, PrivacyDetector } from '@/lib/privacy/adapters/types';
import {
  IBAN_LENGTHS,
  isPlausibleUkDrivingLicence,
  isValidCardNumber,
  isValidIban,
  isValidNhsNumber,
  isValidNino,
  isValidUkVat,
} from '@/lib/privacy/pii/checksums';
import { phoneCandidates } from '@/lib/privacy/pii/phones';
import { allMatches, createYielder, hasContextBefore, span } from '@/lib/privacy/pii/text';

export const RULES_DETECTOR_ID = 'core.rules';

/** What tier A may report; declared to the registry. */
export const RULES_ENTITY_TYPES = [
  'EMAIL',
  'PHONE',
  'POSTCODE',
  'UK_NINO',
  'NHS_NUMBER',
  'SORT_CODE',
  'BANK_ACCOUNT',
  'IBAN',
  'CARD_NUMBER',
  'UK_UTR',
  'UK_VAT',
  'UK_PASSPORT',
  'UK_DRIVING_LICENCE',
  'IP_ADDRESS',
  'SECRET',
  'DATE_OF_BIRTH',
] as const satisfies readonly EntityType[];

type Recogniser = (text: string) => DetectedSpan[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The longest part of a separator-tolerant match that passes `valid`, as
 * offsets in `text`.
 *
 * A greedy pattern for a spaced number runs on into whatever digits follow
 * ("4111 1111 1111 1111 12/27"), so the match is shortened one significant
 * character at a time until the compact form validates. With
 * `fromAnyGroup`, each group of the match is tried as the start as well, for
 * digits written just before the number ("Qty 2 4111 1111 1111 1111").
 * Returns null when nothing of at least `minLength` characters validates.
 */
function longestValid(
  start: number,
  raw: string,
  isSignificant: (ch: string) => boolean,
  minLength: number,
  valid: (compact: string) => boolean,
  fromAnyGroup = false
): { start: number; end: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  const groupStarts: number[] = [];
  let compact = '';
  for (let i = 0; i < raw.length; i++) {
    if (isSignificant(raw[i])) {
      if (compact.length === 0 || !isSignificant(raw[i - 1])) groupStarts.push(compact.length);
      compact += raw[i];
      starts.push(start + i);
      ends.push(start + i + 1);
    }
  }
  let best: { start: number; end: number; length: number } | null = null;
  for (const from of fromAnyGroup ? groupStarts : [0]) {
    for (let len = compact.length - from; len >= minLength; len--) {
      if (best && len <= best.length) break;
      if (valid(compact.slice(from, from + len))) {
        best = { start: starts[from], end: ends[from + len - 1], length: len };
        break;
      }
    }
  }
  return best && { start: best.start, end: best.end };
}

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isAlnum = (ch: string) => /[A-Z0-9]/.test(ch);

// ---------------------------------------------------------------------------
// Recognisers
// ---------------------------------------------------------------------------

const EMAIL =
  /(?<![\w.%+-])[\w.%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;

function emails(text: string): DetectedSpan[] {
  return allMatches(EMAIL, text).map((m) => span('EMAIL', m.index, m.index + m[0].length, 1));
}

/**
 * Words that make a number the model would not otherwise call a phone number
 * one: Ofcom's drama ranges (07700 900xxx) are "possible" but not "valid".
 */
const PHONE_CONTEXT =
  /\b(?:phone[ds]?|tel|telephone|mobile|mob|cell|call(?:ed|ing|s)?|ring(?:ing)?|rang|text(?:ed|ing)?|whatsapp|sms|landline|line|dial|reach|contact(?:ed)?)\b|\b(?:t|m)\s*[:.]/i;

/**
 * Phone numbers. One the library calls valid is reported; one that is only
 * possible (a reserved or unallocated range) needs a phone word just before
 * it.
 */
function phones(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const c of phoneCandidates(text)) {
    if (c.valid) out.push(span('PHONE', c.start, c.end, 0.9));
    else if (hasContextBefore(text, c.start, PHONE_CONTEXT, 30)) {
      out.push(span('PHONE', c.start, c.end, 0.85));
    }
  }
  return out;
}

/**
 * UK postcodes. Outward code letters follow Royal Mail's position rules, and
 * the inward code's letters never include C, I, K, M, O or V. Written in
 * capitals, the space is optional; in lower or mixed case it is required, so
 * an ordinary lower-case word cannot match.
 */
const POSTCODE =
  /(?<![A-Za-z0-9])(?:GIR ?0AA|[A-PR-UWYZ](?:\d[A-HJKPSTUW\d]?|[A-HK-Y]\d[ABEHMNPRV-Y\d]?) ?\d[ABD-HJLNP-UW-Z]{2})(?![A-Za-z0-9])/gi;

function postcodes(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(POSTCODE, text)) {
    const value = m[0];
    if (value !== value.toUpperCase() && !value.includes(' ')) continue;
    out.push(span('POSTCODE', m.index, m.index + value.length, 0.95));
  }
  return out;
}

const NINO_CONTEXT = /national\s+insurance|\bNI\s*(?:no|number|#)|\bNINO\b/i;
const NINO = /(?<![A-Za-z0-9])([A-Z]{2}) ?(\d{2}) ?(\d{2}) ?(\d{2})(?: ?([A-D]))?(?![A-Za-z0-9])/gi;

/**
 * National Insurance numbers. With the suffix letter the shape is distinctive
 * and reported outright; without it, "AB123456" could be any reference, so it
 * needs a National Insurance word nearby. Lower case needs the context too.
 */
function ninos(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(NINO, text)) {
    let matched = m[0];
    let suffix: string | undefined = m[5];
    // "AB123456 a dog": a lower-case letter after a capitalised number is the
    // next word, not the suffix.
    const prefixUpper = m[1] === m[1].toUpperCase();
    if (suffix !== undefined && prefixUpper && suffix !== suffix.toUpperCase()) {
      matched = matched.slice(0, matched.length - 1).trimEnd();
      suffix = undefined;
    }
    const compact = matched.replace(/ /g, '');
    const upper = compact.toUpperCase();
    if (!isValidNino(upper)) continue;
    const context = hasContextBefore(text, m.index, NINO_CONTEXT, 40);
    const strict = compact === upper && suffix !== undefined;
    if (strict || context) {
      out.push(span('UK_NINO', m.index, m.index + matched.length, strict ? 1 : 0.9));
    }
  }
  return out;
}

const NHS_CONTEXT = /\bNHS\b|\bpatient\b|\bhospital\b|\bGP\b|\bCHI\b/i;
const NHS = /(?<!\d)(\d{3})([ -]?)(\d{3})\2(\d{4})(?!\d)/g;

/**
 * NHS numbers: ten digits with a valid modulus 11 check. About one random
 * ten-digit number in eleven passes, so a bare one also needs the 3-3-4
 * grouping NHS numbers are printed in, or a health word nearby.
 */
function nhsNumbers(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(NHS, text)) {
    if (!isValidNhsNumber(m[1] + m[3] + m[4])) continue;
    if (m[2] !== '' || hasContextBefore(text, m.index, NHS_CONTEXT, 40)) {
      out.push(span('NHS_NUMBER', m.index, m.index + m[0].length, 1));
    }
  }
  return out;
}

const SORT_CODE_CONTEXT = /sort\s*code|\bsort\b|\bs\/c\b|\bbank\b/i;
const ACCOUNT_CONTEXT = /\baccount\b|\bacc(?:t)?\b\.?|\ba\/c\b|\bacct\s*(?:no|number)?\b/i;
const SORT_CODE = /(?<!\d)\d{2}([- ]?)\d{2}\1\d{2}(?![\d/-])/g;
const ACCOUNT = /(?<!\d)\d{8}(?!\d)/g;
const NEARBY_ACCOUNT = /^\D{0,25}(?<!\d)\d{8}(?!\d)/;
const NEARBY_SORT_CODE = /(?<!\d)\d{2}[- ]?\d{2}[- ]?\d{2}\D{0,25}$/;

/**
 * Sort codes and account numbers. Neither has a public check (modulus
 * checking needs the clearing tables), and "12-03-24" is also a date, so each
 * needs a banking word before it, or the other one beside it.
 */
function bankDetails(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(SORT_CODE, text)) {
    const end = m.index + m[0].length;
    if (
      hasContextBefore(text, m.index, SORT_CODE_CONTEXT, 25) ||
      NEARBY_ACCOUNT.test(text.slice(end, end + 40))
    ) {
      out.push(span('SORT_CODE', m.index, end, 0.95));
    }
  }
  for (const m of allMatches(ACCOUNT, text)) {
    const end = m.index + m[0].length;
    if (
      hasContextBefore(text, m.index, ACCOUNT_CONTEXT, 30) ||
      NEARBY_SORT_CODE.test(text.slice(Math.max(0, m.index - 40), m.index))
    ) {
      out.push(span('BANK_ACCOUNT', m.index, end, 0.95));
    }
  }
  return out;
}

const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![a-z0-9])/g;

/** IBANs, printed compact or in groups of four, checked mod 97. */
function ibans(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(IBAN, text)) {
    const minLength = IBAN_LENGTHS[m[0].slice(0, 2)] ?? 15;
    const found = longestValid(m.index, m[0], isAlnum, minLength, isValidIban);
    if (found) out.push(span('IBAN', found.start, found.end, 1));
  }
  return out;
}

const CARD = /(?<![\d-])\d(?:[ -]?\d){11,18}(?!\d)/g;

/** Payment cards: a scheme's prefix and length, and a passing Luhn check. */
function cards(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(CARD, text)) {
    const found = longestValid(m.index, m[0], isDigit, 12, isValidCardNumber, true);
    if (found) out.push(span('CARD_NUMBER', found.start, found.end, 1));
  }
  return out;
}

const UTR_CONTEXT =
  /\bUTR\b|unique\s+tax(?:payer)?\s+ref|tax\s+ref(?:erence)?|self[- ]assessment|\bHMRC\b/i;
const UTR = /(?<!\d)\d{5} ?\d{5}(?!\d)K?/g;

/**
 * Unique Taxpayer References: ten digits. Too common a shape to report
 * without a tax word nearby.
 */
function utrs(text: string): DetectedSpan[] {
  return allMatches(UTR, text)
    .filter((m) => hasContextBefore(text, m.index, UTR_CONTEXT, 40))
    .map((m) => span('UK_UTR', m.index, m.index + m[0].length, 0.95));
}

const VAT_PREFIXED = /(?<![A-Za-z0-9])GB ?(\d{3}) ?(\d{4}) ?(\d{2})(?: ?(\d{3}))?(?!\d)/gi;
const VAT_BARE = /(?<![A-Za-z0-9])(\d{3}) ?(\d{4}) ?(\d{2})(?!\d)/g;
const VAT_CONTEXT = /\bVAT\b/i;

/**
 * UK VAT numbers, checked by HMRC's modulus 97 rules. With the GB prefix the
 * check is enough; without it, the number needs "VAT" nearby as well.
 */
function vatNumbers(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(VAT_PREFIXED, text)) {
    if (isValidUkVat(m[1] + m[2] + m[3])) {
      out.push(span('UK_VAT', m.index, m.index + m[0].length, 1));
    }
  }
  for (const m of allMatches(VAT_BARE, text)) {
    if (isValidUkVat(m[1] + m[2] + m[3]) && hasContextBefore(text, m.index, VAT_CONTEXT, 30)) {
      out.push(span('UK_VAT', m.index, m.index + m[0].length, 1));
    }
  }
  return out;
}

const PASSPORT_CONTEXT = /passport/i;
const PASSPORT = /(?<![A-Za-z0-9])\d{9}(?![A-Za-z0-9])/g;

/** UK passport numbers: nine digits, only near "passport". */
function passports(text: string): DetectedSpan[] {
  return allMatches(PASSPORT, text)
    .filter((m) => hasContextBefore(text, m.index, PASSPORT_CONTEXT, 40))
    .map((m) => span('UK_PASSPORT', m.index, m.index + m[0].length, 0.95));
}

const LICENCE_CONTEXT = /driving\s+licen[cs]e|\bDL\b|licen[cs]e\s+(?:no|number)/i;
const LICENCE = /(?<![A-Za-z0-9])[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}(?: ?\d{2})?(?![A-Za-z0-9])/g;

/**
 * UK (DVLA) driving licence numbers: sixteen characters encoding the surname,
 * date of birth and initials. Distinctive enough to report on shape when the
 * encoded date is possible; a licence word nearby raises it to certain.
 */
function drivingLicences(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(LICENCE, text)) {
    if (!isPlausibleUkDrivingLicence(m[0].slice(0, 16))) continue;
    const context = hasContextBefore(text, m.index, LICENCE_CONTEXT, 40);
    out.push(span('UK_DRIVING_LICENCE', m.index, m.index + m[0].length, context ? 1 : 0.95));
  }
  return out;
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\d.])(?:${OCTET}\\.){3}${OCTET}(?!\\d|\\.\\d)`, 'g');
const IPV6 = /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;
/** "v1.2.3.4" and "version 1.2.3.4" are versions, not addresses. */
const VERSION_CONTEXT =
  /(?:\bv|\b(?:version|release|build|firmware)(?:\s+(?:is|was|number|no\.?))?\s*:?\s*)$/i;

/** IPv6 validity, by asking the URL parser: no hand-rolled grammar. */
function isIpv6(candidate: string): boolean {
  if (!/\d/.test(candidate) || candidate.length < 3) return false;
  // "cafe::1" and "dead::beef" parse too. An address in text has four or more
  // groups, or starts like a real one: global (2xxx, 3xxx), link-local
  // (fe80), unique-local (fc/fd), loopback or IPv4-mapped.
  const groups = candidate.split(':').filter((g) => g !== '').length;
  const realStart = /^(?:[23][0-9a-f]{3}|fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):|^::(?:1$|ffff:)/i;
  if (groups < 4 && !realStart.test(candidate)) return false;
  try {
    new URL(`http://[${candidate}]/`);
    return true;
  } catch {
    return false;
  }
}

function ipAddresses(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of allMatches(IPV4, text)) {
    if (hasContextBefore(text, m.index, VERSION_CONTEXT, 20)) continue;
    out.push(span('IP_ADDRESS', m.index, m.index + m[0].length, 0.95));
  }
  for (const m of allMatches(IPV6, text)) {
    if (isIpv6(m[0])) out.push(span('IP_ADDRESS', m.index, m.index + m[0].length, 0.95));
  }
  return out;
}

/**
 * Credentials with a published, distinctive prefix. Each is certain on shape:
 * nobody writes `ghp_` and 36 letters by accident.
 */
const PREFIXED_SECRETS: readonly RegExp[] = [
  /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /(?<!\w)gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub tokens
  /(?<!\w)github_pat_[A-Za-z0-9_]{40,}/g, // GitHub fine-grained tokens
  /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g, // AWS access key ids
  /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![\w-])AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret and restricted
  /(?<!\w)whsec_[A-Za-z0-9+/=]{20,}/g, // webhook signing secrets
  /(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]{0,10000}?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
];

/**
 * A value assigned to a credential-sounding name: `password: hunter22`,
 * `api_key=...`, `Bearer ...`. The span is the value only, so the model still
 * sees that a password was there.
 */
/**
 * Names that hold a password. The value after one is taken whatever it looks
 * like: real weak passwords are plain words.
 */
const PASSWORD_NAME = '(?:password|passwd|pwd|passcode)';
/**
 * Other credential names. "Token: please see the attached" is a label, so the
 * value after one of these must look like a credential (see CREDENTIAL_VALUE).
 */
const OTHER_CREDENTIAL_NAME =
  '(?:secret|api[_ -]?key|access[_ -]?key|secret[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|token|pin)';
const CREDENTIAL_NAME = `(?:${PASSWORD_NAME}|${OTHER_CREDENTIAL_NAME})`;
/**
 * Not `\b`: an underscore is a word character, so `\bpassword` misses
 * DB_PASSWORD and csrf_token, which is how a pasted .env file names them.
 */
const NAME_START = '(?<![A-Za-z0-9])';
/** A value with a digit or symbol in it, or one too long to be a word. */
const CREDENTIAL_VALUE =
  '(?:(?=[^\\s"\'`,;]*[\\d!@#$%^&*_+/=-])[^\\s"\'`,;]{6,}|[^\\s"\'`,;]{16,})';
const ASSIGNED_SECRET = new RegExp(
  // `["']?` before the separator for a quoted key: {"password": "…"}.
  `${NAME_START}${PASSWORD_NAME}["']?\\s*[:=]\\s*["']?([^\\s"'\`,;]{6,})`,
  'gi'
);
const ASSIGNED_OTHER_SECRET = new RegExp(
  `${NAME_START}${OTHER_CREDENTIAL_NAME}["']?\\s*[:=]\\s*["']?(${CREDENTIAL_VALUE})`,
  'gi'
);
/**
 * "the password is Tr0ub4dor&3", but not "the password is correct": after
 * "is" the value must look like a credential — a letter and a digit or symbol.
 */
const STATED_SECRET = new RegExp(
  `${NAME_START}${CREDENTIAL_NAME}\\s+is\\s+["']?((?=[^\\s"'\`,;]*[A-Za-z])(?=[^\\s"'\`,;]*[\\d!@#$%^&*])[^\\s"'\`,;]{6,})`,
  'gi'
);
/** A PIN is digits, and shorter than any other credential. */
const PIN = /\bPIN\b\s*(?:number\s*|code\s*)?(?:is\s*|[:=]\s*)?(\d{4,8})(?!\d)/gi;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g;
/**
 * "using the password Tr0ub4dor&3": no separator, so the value must look like
 * a credential — a letter and a digit or symbol — or "password reset" would
 * mask "reset".
 */
const UNSEPARATED_PASSWORD =
  /(?<![A-Za-z0-9])(?:password|passwd|passcode)\s+((?=[^\s"'`,;]*[A-Za-z])(?=[^\s"'`,;]*[\d!@#$%^&*])[^\s"'`,;]{6,})/gi;

function secrets(text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const pattern of PREFIXED_SECRETS) {
    for (const m of allMatches(pattern, text)) {
      out.push(span('SECRET', m.index, m.index + m[0].length, 1));
    }
  }
  for (const pattern of [
    ASSIGNED_SECRET,
    ASSIGNED_OTHER_SECRET,
    STATED_SECRET,
    BEARER,
    UNSEPARATED_PASSWORD,
    PIN,
  ]) {
    for (const m of allMatches(pattern, text)) {
      // The capture is the match's tail, so its start is measured from the end.
      const start = m.index + m[0].length - m[1].length;
      // Sentence punctuation after a password is usually not part of it; when
      // trimming it would leave too little to be a password, it was.
      const trimmed = m[1].replace(/[.,!?)\]}]+$/, '');
      const value = trimmed.length >= 6 ? trimmed : m[1];
      out.push(span('SECRET', start, start + value.length, 0.9));
    }
  }
  return out;
}

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE = new RegExp(
  [
    '(?<!\\d)(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:\\d{4}|\\d{2})(?!\\d)',
    '(?<!\\d)\\d{4}[/.-](?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\\d|3[01])(?!\\d)',
    // US order, when the day makes it unambiguous ("12/25/1990"); an
    // ambiguous one already matches day-first above.
    '(?<!\\d)(?:0?[1-9]|1[0-2])[/.-](?:1[3-9]|2\\d|3[01])[/.-](?:\\d{4}|\\d{2})(?!\\d)',
    `(?<!\\d)(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?,?\\s+\\d{4}(?!\\d)`,
    `\\b(?:${MONTHS})\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?,?\\s+\\d{4}(?!\\d)`,
  ].join('|'),
  'gi'
);
const DOB_CONTEXT =
  /\b(?:born|DOB|D\.O\.B\.?|date\s+of\s+birth|birth\s*date|birthday|b\.)\s*(?:on|is|was|:|-|–|—)?\s*(?:the\s+)?$/i;

/**
 * Dates of birth: a date with a birth word just before it. Any other date is
 * left alone — appointment and invoice dates are what the model needs.
 */
function datesOfBirth(text: string): DetectedSpan[] {
  return allMatches(DATE, text)
    .filter((m) => hasContextBefore(text, m.index, DOB_CONTEXT, 30))
    .map((m) => span('DATE_OF_BIRTH', m.index, m.index + m[0].length, 0.9));
}

/** Every tier A recogniser, in no particular order: the overlap merge is order-free. */
const RECOGNISERS: readonly Recogniser[] = [
  emails,
  phones,
  postcodes,
  ninos,
  nhsNumbers,
  bankDetails,
  ibans,
  cards,
  utrs,
  vatNumbers,
  passports,
  drivingLicences,
  ipAddresses,
  secrets,
  datesOfBirth,
];

/**
 * Tier A as a detector adapter. The recognisers are synchronous, so once a
 * time slice of work has passed it gives the event loop a turn and checks its
 * signal: a timeout that expired during the work fires in that turn, and the
 * detector rejects instead of handing back a late result.
 */
export function rulesDetector(): PrivacyDetector {
  return {
    id: RULES_DETECTOR_ID,
    egress: 'in_process',
    entityTypes: RULES_ENTITY_TYPES,
    detect: async ({ text }, ctx) => {
      const maybeYield = createYielder();
      const out: DetectedSpan[] = [];
      for (const recognise of RECOGNISERS) {
        ctx.signal.throwIfAborted();
        out.push(...recognise(text));
        await maybeYield();
      }
      ctx.signal.throwIfAborted();
      return out;
    },
  };
}

// Exported for the unit tests of each recogniser.
export const __recognisersForTests = {
  emails,
  phones,
  postcodes,
  ninos,
  nhsNumbers,
  bankDetails,
  ibans,
  cards,
  utrs,
  vatNumbers,
  passports,
  drivingLicences,
  ipAddresses,
  secrets,
  datesOfBirth,
};
