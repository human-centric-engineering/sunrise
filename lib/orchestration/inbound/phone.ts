/**
 * E.164 phone normalisation for inbound channels.
 *
 * Both Twilio and Meta WhatsApp Cloud deliver phone numbers in near-E.164
 * form but with vendor-specific quirks:
 *   - Twilio prefixes WhatsApp messages with `whatsapp:` (e.g.
 *     `whatsapp:+447700900123`).
 *   - Twilio occasionally sends spaced E.164 (`+44 7700 900123`) on
 *     certain MNO chains.
 *   - Meta sometimes omits the leading `+` (e.g. `447700900123`).
 *
 * Inconsistent normalisation is **correctness- and compliance-critical** —
 * the same human ends up with two `(channel, fromAddress)` keyed
 * conversations, and a STOP / opt-out flag on one row doesn't block
 * outbound on the other. `libphonenumber-js` (Google's libphonenumber port)
 * handles every documented variation; the helper below wraps it with the
 * `whatsapp:` strip and the `defaultCountry` fallback for the
 * leading-`+`-less case.
 */

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

const WHATSAPP_PREFIX = 'whatsapp:';

/**
 * Normalise a raw phone number string to E.164.
 *
 * @param raw - Input from a vendor webhook (may include `whatsapp:` prefix,
 *   spaces, or a missing leading `+`).
 * @param defaultCountry - ISO-3166 two-letter code used only when `raw`
 *   lacks a leading `+` (so libphonenumber knows which country code to
 *   prepend). Falls back to `INBOUND_DEFAULT_COUNTRY` env var, then `GB`.
 *   For Twilio inputs the leading `+` is always present and this is
 *   ignored; for Meta inputs it matters.
 * @returns E.164 string (e.g. `+447700900123`) or `null` if input is not
 *   a valid phone number.
 */
export function normaliseToE164(
  raw: string | null | undefined,
  defaultCountry?: CountryCode
): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const stripped = raw.startsWith(WHATSAPP_PREFIX) ? raw.slice(WHATSAPP_PREFIX.length) : raw;

  const country =
    defaultCountry ?? (process.env.INBOUND_DEFAULT_COUNTRY as CountryCode | undefined) ?? 'GB';

  const parsed = parsePhoneNumberFromString(stripped.trim(), country);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.format('E.164');
}

/**
 * Convenience: same as `normaliseToE164` but throws if the result is null.
 * Use only when the caller has already established the input must be
 * valid (e.g. inside an adapter that has already verified the inbound
 * signature). The throw is a programmer-error signal, not a user-facing
 * error path.
 */
export function normaliseToE164OrThrow(
  raw: string | null | undefined,
  defaultCountry?: CountryCode
): string {
  const result = normaliseToE164(raw, defaultCountry);
  if (result === null) {
    throw new Error(`normaliseToE164: invalid phone number input: ${JSON.stringify(raw)}`);
  }
  return result;
}
