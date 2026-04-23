/**
 * Tests: Hook webhook signing (HMAC-SHA256).
 *
 * @see lib/orchestration/hooks/signing.ts
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_MAX_AGE_SEC,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  generateHookSecret,
  signHookPayload,
  verifyHookSignature,
} from '@/lib/orchestration/hooks/signing';

const SECRET = 'a'.repeat(64);
const BODY =
  '{"eventType":"conversation.started","timestamp":"2026-04-23T00:00:00.000Z","data":{}}';
const PINNED_TS = 1_714_000_000; // fixed epoch second for deterministic tests

describe('generateHookSecret', () => {
  it('produces a 64-character hex string (32 bytes)', () => {
    const secret = generateHookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a distinct value on each call', () => {
    const a = generateHookSecret();
    const b = generateHookSecret();
    expect(a).not.toBe(b);
  });
});

describe('signHookPayload', () => {
  it('returns the pinned timestamp as a string and a sha256-prefixed hex signature', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    expect(timestamp).toBe(String(PINNED_TS));
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('signature matches independent HMAC recomputation over `${timestamp}.${body}`', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('defaults timestamp to current epoch second when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signHookPayload(SECRET, BODY);
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('produces a different signature when the timestamp changes (retry refresh)', () => {
    const first = signHookPayload(SECRET, BODY, PINNED_TS);
    const second = signHookPayload(SECRET, BODY, PINNED_TS + 1);
    expect(second.timestamp).not.toBe(first.timestamp);
    expect(second.signature).not.toBe(first.signature);
  });

  it('produces a different signature for a different body', () => {
    const a = signHookPayload(SECRET, BODY, PINNED_TS);
    const b = signHookPayload(SECRET, `${BODY} `, PINNED_TS);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('verifyHookSignature', () => {
  it('accepts a freshly-signed payload (happy path)', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, signature, { nowSec: PINNED_TS });
    expect(result).toEqual({ valid: true });
  });

  it('rejects when timestamp header is missing', () => {
    const { signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, null, signature, { nowSec: PINNED_TS });
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects when signature header is missing', () => {
    const { timestamp } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, null, { nowSec: PINNED_TS });
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects a non-integer timestamp', () => {
    const { signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, '1714000000.5', signature, {
      nowSec: PINNED_TS,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects a signature without the sha256= prefix', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const stripped = signature.slice('sha256='.length);
    const result = verifyHookSignature(SECRET, BODY, timestamp, stripped, { nowSec: PINNED_TS });
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects a signature with non-hex characters', () => {
    const { timestamp } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, 'sha256=zzz', {
      nowSec: PINNED_TS,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects a stale timestamp beyond the default max-age window', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, signature, {
      nowSec: PINNED_TS + DEFAULT_MAX_AGE_SEC + 1,
    });
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('rejects a timestamp far in the future beyond the max-age window', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, signature, {
      nowSec: PINNED_TS - DEFAULT_MAX_AGE_SEC - 1,
    });
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('honors a caller-supplied maxAgeSec override', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, signature, {
      nowSec: PINNED_TS + 60,
      maxAgeSec: 30,
    });
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('rejects when the body has been tampered with', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, `${BODY}X`, timestamp, signature, {
      nowSec: PINNED_TS,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects when the wrong secret is used', () => {
    const { timestamp, signature } = signHookPayload(SECRET, BODY, PINNED_TS);
    const wrongSecret = 'b'.repeat(64);
    const result = verifyHookSignature(wrongSecret, BODY, timestamp, signature, {
      nowSec: PINNED_TS,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a signature with the wrong hex length (avoids timingSafeEqual throw)', () => {
    const { timestamp } = signHookPayload(SECRET, BODY, PINNED_TS);
    const result = verifyHookSignature(SECRET, BODY, timestamp, 'sha256=deadbeef', {
      nowSec: PINNED_TS,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });
});

describe('constants', () => {
  it('exports the expected header names', () => {
    expect(SIGNATURE_HEADER).toBe('X-Sunrise-Signature');
    expect(TIMESTAMP_HEADER).toBe('X-Sunrise-Timestamp');
  });

  it('uses a 5-minute default max-age window', () => {
    expect(DEFAULT_MAX_AGE_SEC).toBe(300);
  });
});
