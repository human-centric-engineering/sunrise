/**
 * Tests: GenericHmacAdapter — verify + normalise.
 *
 * Security-critical: uses REAL verifyHookSignature (not mocked).
 * Test signatures are generated with signHookPayload so the full
 * HMAC path is exercised end-to-end.
 *
 * @see lib/orchestration/inbound/adapters/generic-hmac.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GenericHmacAdapter } from '@/lib/orchestration/inbound/adapters/generic-hmac';
import { signHookPayload } from '@/lib/orchestration/hooks/signing';
import type { VerifyContext } from '@/lib/orchestration/inbound/types';

// Fixed test values — deterministic across all tests.
const SECRET = 'a'.repeat(64);
const RAW_BODY = '{"hello":"world"}';
const PINNED_TS = 1_714_000_000; // epoch second well within the 300s window

/** Build a minimal NextRequest with the given header map. */
function makeRequest(headerMap: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/inbound/hmac/my-trigger', {
    method: 'POST',
    headers: headerMap,
  });
}

/** Base VerifyContext with a valid signingSecret. */
function baseCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    signingSecret: SECRET,
    rawBody: RAW_BODY,
    metadata: {},
    ...overrides,
  };
}

let adapter: GenericHmacAdapter;

beforeEach(() => {
  adapter = new GenericHmacAdapter();
});

// ---------------------------------------------------------------------------
// verify — failure paths
// ---------------------------------------------------------------------------

describe('GenericHmacAdapter.verify — failure paths', () => {
  it('returns {valid:false, reason:"missing_secret_config"} when signingSecret is null', async () => {
    // Arrange
    const { timestamp, signature } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const req = makeRequest({
      'x-sunrise-signature': signature,
      'x-sunrise-timestamp': timestamp,
    });
    const ctx = baseCtx({ signingSecret: null });

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert — fail closed; no other check matters when there is no secret
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing_secret_config');
    }
  });

  it('returns {valid:false, reason:"missing_signature"} when X-Sunrise-Signature header is absent', async () => {
    // Arrange — only timestamp present
    const { timestamp } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const req = makeRequest({ 'x-sunrise-timestamp': timestamp });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing_signature');
    }
  });

  it('returns {valid:false, reason:"missing_signature"} when X-Sunrise-Timestamp header is absent', async () => {
    // Arrange — only signature present
    const { signature } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const req = makeRequest({ 'x-sunrise-signature': signature });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing_signature');
    }
  });

  it('propagates bad_format from verifyHookSignature when signature lacks sha256= prefix', async () => {
    // Arrange — strip the prefix to produce a bare hex string
    const { timestamp, signature } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const bareHex = signature.slice('sha256='.length);
    const req = makeRequest({
      'x-sunrise-signature': bareHex,
      'x-sunrise-timestamp': timestamp,
    });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert — verifyHookSignature returns bad_format; adapter propagates it
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('propagates bad_format on non-hex signature value (after sha256= prefix)', async () => {
    // Arrange — non-hex content after the prefix
    const { timestamp } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const req = makeRequest({
      'x-sunrise-signature': 'sha256=not-valid-hex!',
      'x-sunrise-timestamp': timestamp,
    });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('propagates bad_format on non-numeric timestamp', async () => {
    // Arrange — timestamp is a word, not a number
    const { signature } = signHookPayload(SECRET, RAW_BODY, PINNED_TS);
    const req = makeRequest({
      'x-sunrise-signature': signature,
      'x-sunrise-timestamp': 'not-a-number',
    });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_format');
    }
  });

  it('propagates stale_timestamp when timestamp exceeds the 300s replay window', async () => {
    // Arrange — sign with a timestamp one year in the past; verifyHookSignature uses
    // the real wall-clock as "now", so this is safely outside the 300s window.
    const yearAgoTs = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
    const { timestamp: staleTimestamp, signature: staleSignature } = signHookPayload(
      SECRET,
      RAW_BODY,
      yearAgoTs
    );
    const req = makeRequest({
      'x-sunrise-signature': staleSignature,
      'x-sunrise-timestamp': staleTimestamp,
    });
    const ctx = baseCtx();

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('stale_timestamp');
    }
  });

  it('propagates bad_signature when the HMAC does not match (tampered body)', async () => {
    // Arrange — pin the clock so the timestamp stays within the 300s replay window
    // when verifyHookSignature reads Date.now() internally.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    const { timestamp, signature } = signHookPayload(SECRET, RAW_BODY, nowSec);
    const req = makeRequest({
      'x-sunrise-signature': signature,
      'x-sunrise-timestamp': timestamp,
    });
    // ctx.rawBody differs from what was signed — adapter passes this to verifyHookSignature
    const ctx = baseCtx({ rawBody: RAW_BODY + 'tampered' });

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert — signature was computed over RAW_BODY; ctx carries tampered body → bad_signature
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// verify — success paths
// ---------------------------------------------------------------------------

// Fixed epoch second used across all success-path tests.
// Pinning the clock ensures verifyHookSignature sees the same "now" as signHookPayload,
// keeping the signed timestamp within the 300s replay window deterministically.
const FIXED_DATE = new Date('2026-05-01T00:00:00Z');
const FIXED_NOW_SEC = Math.floor(FIXED_DATE.getTime() / 1000);

describe('GenericHmacAdapter.verify — success paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns {valid:true} on a correct HMAC over the supplied rawBody', async () => {
    // Arrange — sign the exact rawBody that ctx will provide
    const { timestamp, signature } = signHookPayload(SECRET, RAW_BODY, FIXED_NOW_SEC);
    const req = makeRequest({
      'x-sunrise-signature': signature,
      'x-sunrise-timestamp': timestamp,
    });
    const ctx = baseCtx({ rawBody: RAW_BODY });

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert
    expect(result.valid).toBe(true);
  });

  it('verify never returns externalId — dedup material comes from the signed body via normalise', async () => {
    // Arrange — valid signature WITH an unsigned x-sunrise-event-id header that
    // earlier versions of this adapter consumed. Reading dedup material from an
    // unsigned header would let any captured request be replayed by mutating
    // the header — verify must ignore the header entirely.
    const { timestamp, signature } = signHookPayload(SECRET, RAW_BODY, FIXED_NOW_SEC);
    const req = makeRequest({
      'x-sunrise-signature': signature,
      'x-sunrise-timestamp': timestamp,
      'x-sunrise-event-id': 'evt_unsigned_header_must_be_ignored',
    });
    const ctx = baseCtx({ rawBody: RAW_BODY });

    // Act
    const result = await adapter.verify(req, ctx);

    // Assert — valid AND the unsigned header MUST NOT propagate as externalId
    expect(result.valid).toBe(true);
    expect(result).not.toHaveProperty('externalId');
  });
});

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

describe('GenericHmacAdapter.normalise', () => {
  it('wraps the parsed JSON body in {body} inside the payload field', () => {
    // Arrange
    const parsedBody = { hello: 'world', count: 42 };
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert — payload.body must be the exact object reference passed in
    expect(result.channel).toBe('hmac');
    expect(result.payload).toEqual({ body: parsedBody });
  });

  it('reads externalId from body.eventId (signed); ignores any x-sunrise-event-id header', () => {
    // Arrange — body carries eventId; an unsigned header tries to override it
    const parsedBody = { foo: 'bar', eventId: 'evt_from_body' };
    const headers = new Headers({ 'x-sunrise-event-id': 'evt_from_unsigned_header' });

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert — body wins; header is never read
    expect(result.externalId).toBe('evt_from_body');
  });

  it('OMITS externalId property when body.eventId is absent', () => {
    // Arrange — body has no eventId, even though an unsigned header is present
    const parsedBody = { foo: 'bar' };
    const headers = new Headers({ 'x-sunrise-event-id': 'evt_unsigned_header_must_be_ignored' });

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert — structurally absent (the unsigned header must not propagate)
    expect(result).not.toHaveProperty('externalId');
  });

  it('OMITS externalId when body.eventId is a non-string value', () => {
    // Arrange — coercion guard: a number eventId is treated as missing, not String(123)
    const parsedBody = { eventId: 123 };
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert — strict string requirement; non-strings are dropped
    expect(result).not.toHaveProperty('externalId');
  });

  it('OMITS externalId when body.eventId is an empty string', () => {
    // Arrange — empty string is treated as missing (matches readBodyString contract)
    const parsedBody = { eventId: '' };
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert
    expect(result).not.toHaveProperty('externalId');
  });

  it('reads eventType from body.eventType', () => {
    // Arrange
    const parsedBody = { eventType: 'order.created' };
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert
    expect(result.eventType).toBe('order.created');
  });

  it('OMITS eventType when body.eventType is absent', () => {
    // Arrange
    const parsedBody = {};
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert
    expect(result).not.toHaveProperty('eventType');
  });

  it('includes both externalId and eventType when both fields are in the body', () => {
    // Arrange
    const parsedBody = { key: 'value', eventId: 'evt_both', eventType: 'payment.captured' };
    const headers = new Headers();

    // Act
    const result = adapter.normalise(parsedBody, headers);

    // Assert
    expect(result.externalId).toBe('evt_both');
    expect(result.eventType).toBe('payment.captured');
    expect(result.payload).toEqual({ body: parsedBody });
  });
});
