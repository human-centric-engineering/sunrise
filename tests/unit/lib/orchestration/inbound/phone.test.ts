/**
 * Tests: phone normalisation for inbound channels.
 *
 * The helper wraps libphonenumber-js with the Twilio `whatsapp:` prefix
 * strip + a default-country fallback for inputs lacking a leading `+`
 * (Meta's quirk). The bug class this prevents — two `(channel, fromAddress)`
 * conversation rows for the same human, which lets STOP-list opt-outs
 * leak past — is correctness- and compliance-critical, so the suite
 * exercises every documented vendor variation.
 *
 * @see lib/orchestration/inbound/phone.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { normaliseToE164, normaliseToE164OrThrow } from '@/lib/orchestration/inbound/phone';

const ORIGINAL_DEFAULT_COUNTRY = process.env.INBOUND_DEFAULT_COUNTRY;

afterEach(() => {
  if (ORIGINAL_DEFAULT_COUNTRY === undefined) {
    delete process.env.INBOUND_DEFAULT_COUNTRY;
  } else {
    process.env.INBOUND_DEFAULT_COUNTRY = ORIGINAL_DEFAULT_COUNTRY;
  }
});

describe('normaliseToE164 — vendor format variations', () => {
  it('returns the canonical E.164 for a plain US number with leading +', () => {
    expect(normaliseToE164('+12133734253')).toBe('+12133734253');
  });

  it('returns the canonical E.164 for a plain UK number with leading +', () => {
    expect(normaliseToE164('+447400123456')).toBe('+447400123456');
  });

  it('strips the Twilio `whatsapp:` prefix before parsing', () => {
    expect(normaliseToE164('whatsapp:+447400123456')).toBe('+447400123456');
  });

  it('strips `whatsapp:` from a US number too', () => {
    expect(normaliseToE164('whatsapp:+12133734253')).toBe('+12133734253');
  });

  it('normalises Twilio spaced E.164 to canonical form', () => {
    // Twilio occasionally sends `+44 7400 123456` on certain MNO chains.
    expect(normaliseToE164('+44 7400 123456')).toBe('+447400123456');
  });

  it('normalises Meta payloads without leading + using the default country', () => {
    // Meta sometimes sends `447400123456` without a leading +. The
    // defaultCountry argument tells libphonenumber which country to
    // assume.
    expect(normaliseToE164('447400123456', 'GB')).toBe('+447400123456');
  });

  it('falls back to INBOUND_DEFAULT_COUNTRY env var when no explicit country given', () => {
    process.env.INBOUND_DEFAULT_COUNTRY = 'US';
    expect(normaliseToE164('2133734253')).toBe('+12133734253');
  });

  it('defaults to GB when no explicit country and no env var', () => {
    delete process.env.INBOUND_DEFAULT_COUNTRY;
    // A UK national-format number without leading + should parse as +44...
    expect(normaliseToE164('07400123456')).toBe('+447400123456');
  });
});

describe('normaliseToE164 — rejection of invalid inputs', () => {
  it('returns null for null input', () => {
    expect(normaliseToE164(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normaliseToE164(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normaliseToE164('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normaliseToE164('   ')).toBeNull();
  });

  it('returns null for a number too short to be valid', () => {
    expect(normaliseToE164('+1234')).toBeNull();
  });

  it('returns null for non-numeric garbage', () => {
    expect(normaliseToE164('not-a-phone-number')).toBeNull();
  });

  it('returns null for a `whatsapp:` prefix with no number after', () => {
    expect(normaliseToE164('whatsapp:')).toBeNull();
  });

  it('does not throw on non-string input typed as string', () => {
    // Defensive: some upstream code may pass numbers etc. casted to any.
    expect(normaliseToE164(12345 as unknown as string)).toBeNull();
  });
});

describe('normaliseToE164OrThrow', () => {
  it('returns the canonical form for a valid input', () => {
    expect(normaliseToE164OrThrow('+447400123456')).toBe('+447400123456');
  });

  it('throws on invalid input', () => {
    expect(() => normaliseToE164OrThrow('not-a-phone')).toThrow(/invalid phone number/i);
  });
});
