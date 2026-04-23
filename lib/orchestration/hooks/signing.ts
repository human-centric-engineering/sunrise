/**
 * Hook webhook signing.
 *
 * When an `AiEventHook.secret` is set, we sign outbound webhook bodies
 * with HMAC-SHA256 so receivers can verify they came from us and weren't
 * tampered with in transit.
 *
 * Signature scheme (compatible with Stripe/GitHub-style schemes):
 *
 *   1. Pick a Unix epoch timestamp (seconds) for "now".
 *   2. Build a signed string: `${timestamp}.${rawJsonBody}`.
 *   3. HMAC-SHA256 the signed string with the hex-encoded secret, hex-encode.
 *   4. Send headers:
 *        X-Sunrise-Timestamp: <timestamp>
 *        X-Sunrise-Signature: sha256=<hex>
 *
 * Receivers reconstruct the signed string from the raw body + timestamp
 * header, recompute the signature, and constant-time-compare. The
 * timestamp also defends against replays: receivers reject anything
 * older than `DEFAULT_MAX_AGE_SEC`.
 *
 * Retries refresh the timestamp and re-sign — receivers will see a
 * fresh timestamp/signature pair for every attempt.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Length of a freshly-generated secret in bytes → 64 hex chars. */
const SECRET_BYTES = 32;

/** Accept signatures at most this many seconds old. */
export const DEFAULT_MAX_AGE_SEC = 300;

export const SIGNATURE_HEADER = 'X-Sunrise-Signature';
export const TIMESTAMP_HEADER = 'X-Sunrise-Timestamp';

/** Generate a fresh 256-bit secret as a 64-character hex string. */
export function generateHookSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex');
}

/**
 * Compute the outbound signature headers for a given body + secret.
 * `timestampSec` defaults to the current epoch second; callers (tests)
 * can pin it.
 */
export function signHookPayload(
  secret: string,
  rawBody: string,
  timestampSec: number = Math.floor(Date.now() / 1000)
): { timestamp: string; signature: string } {
  const timestamp = String(timestampSec);
  const signedString = `${timestamp}.${rawBody}`;
  const hex = createHmac('sha256', secret).update(signedString).digest('hex');
  return { timestamp, signature: `sha256=${hex}` };
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: 'bad_format' | 'stale_timestamp' | 'bad_signature' };

/**
 * Verify a webhook signature. Constant-time comparison; returns a
 * reason on failure so consumers can log without leaking signal to
 * attackers (the reason is internal, not surfaced to the sender).
 */
export function verifyHookSignature(
  secret: string,
  rawBody: string,
  timestampHeader: string | null | undefined,
  signatureHeader: string | null | undefined,
  options: { maxAgeSec?: number; nowSec?: number } = {}
): VerifyResult {
  if (!timestampHeader || !signatureHeader) {
    return { valid: false, reason: 'bad_format' };
  }

  const timestampSec = Number(timestampHeader);
  if (!Number.isFinite(timestampSec) || !Number.isInteger(timestampSec)) {
    return { valid: false, reason: 'bad_format' };
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return { valid: false, reason: 'bad_format' };
  }
  const providedHex = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-f]+$/i.test(providedHex)) {
    return { valid: false, reason: 'bad_format' };
  }

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = options.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  if (Math.abs(nowSec - timestampSec) > maxAgeSec) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const expectedHex = createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (provided.length !== expected.length) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  return { valid: true };
}
