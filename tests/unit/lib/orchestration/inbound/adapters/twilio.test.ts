/**
 * Tests: TwilioAdapter — HMAC-SHA1 base64 verification + form-body
 * normalisation + sub-channel discriminator + status-callback detection.
 *
 * Twilio's signing scheme:
 *   - HMAC-SHA1 over `{publicURL}{sortedParamsConcatenated}`, base64.
 *   - URL must match exactly what Twilio sent — the URL-reconstruction
 *     helper handles the proxy/TLS-termination case.
 *   - Per-key sort, then key+value (no separators) concatenated.
 *
 * @see lib/orchestration/inbound/adapters/twilio.ts
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { TwilioAdapter } from '@/lib/orchestration/inbound/adapters/twilio';
import type { TwilioTriggerPayload } from '@/lib/orchestration/inbound/adapters/twilio';
import type { VerifyContext } from '@/lib/orchestration/inbound/types';

const AUTH_TOKEN = 'test-twilio-auth-token-abc123';
const PUBLIC_URL = 'https://app.example.com/api/v1/inbound/twilio/sms-replies';

function buildFormBody(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return sp.toString();
}

function signTwilio(token: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', token).update(`${url}${concatenated}`).digest('base64');
}

function makeReq(url: string, body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

function makeCtx(rawBody: string): VerifyContext {
  return { signingSecret: null, metadata: {}, rawBody };
}

// ─── verify() ────────────────────────────────────────────────────────────────

describe('TwilioAdapter.verify — valid signatures', () => {
  it('accepts a valid SMS signature', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const params = {
      From: '+12133734253',
      To: '+12025550100',
      Body: 'hello',
      MessageSid: 'SM' + 'a'.repeat(32),
    };
    const body = buildFormBody(params);
    const sig = signTwilio(AUTH_TOKEN, PUBLIC_URL, params);

    const req = makeReq(PUBLIC_URL, body, { 'x-twilio-signature': sig });
    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: true, externalId: params.MessageSid });
  });

  it('accepts a valid WhatsApp signature with `whatsapp:` prefix', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const params = {
      From: 'whatsapp:+447400123456',
      To: 'whatsapp:+447400999888',
      Body: 'hello via WA',
      MessageSid: 'SM' + 'b'.repeat(32),
    };
    const body = buildFormBody(params);
    const sig = signTwilio(AUTH_TOKEN, PUBLIC_URL, params);

    const req = makeReq(PUBLIC_URL, body, { 'x-twilio-signature': sig });
    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: true, externalId: params.MessageSid });
  });

  it('returns valid:true with no externalId when MessageSid is absent', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const params = { Body: 'no sid' };
    const body = buildFormBody(params);
    const sig = signTwilio(AUTH_TOKEN, PUBLIC_URL, params);

    const req = makeReq(PUBLIC_URL, body, { 'x-twilio-signature': sig });
    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: true });
  });

  it('honours TWILIO_EXTERNAL_BASE_URL when reconstructing the signed URL', async () => {
    const original = process.env.TWILIO_EXTERNAL_BASE_URL;
    process.env.TWILIO_EXTERNAL_BASE_URL = 'https://public.example.com';
    try {
      const adapter = new TwilioAdapter(AUTH_TOKEN);
      const params = { From: '+12133734253', Body: 'proxied', MessageSid: 'SM' + 'c'.repeat(32) };
      const body = buildFormBody(params);
      // Twilio sees and signs the public URL.
      const publicUrl = 'https://public.example.com/api/v1/inbound/twilio/abc';
      const sig = signTwilio(AUTH_TOKEN, publicUrl, params);

      // But the Next.js process sees the internal URL.
      const internalUrl = 'http://internal:3000/api/v1/inbound/twilio/abc';
      const req = makeReq(internalUrl, body, { 'x-twilio-signature': sig });
      const result = await adapter.verify(req, makeCtx(body));

      expect(result).toEqual({ valid: true, externalId: params.MessageSid });
    } finally {
      if (original === undefined) delete process.env.TWILIO_EXTERNAL_BASE_URL;
      else process.env.TWILIO_EXTERNAL_BASE_URL = original;
    }
  });
});

describe('TwilioAdapter.verify — rejection paths', () => {
  it('rejects when X-Twilio-Signature header is missing', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({ From: '+12133734253', Body: 'hi' });
    const req = makeReq(PUBLIC_URL, body);

    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('rejects when auth token is empty string', async () => {
    const adapter = new TwilioAdapter('');
    const body = buildFormBody({ Body: 'hi' });
    const req = makeReq(PUBLIC_URL, body, { 'x-twilio-signature': 'anything' });

    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'missing_secret_config' });
  });

  it('rejects when signature is wrong', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({ From: '+12133734253', Body: 'hi' });

    const req = makeReq(PUBLIC_URL, body, {
      'x-twilio-signature': Buffer.from('wrong-signature-bytes').toString('base64'),
    });
    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects when the URL Twilio signed and the URL we reconstruct differ', async () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const params = { From: '+12133734253', Body: 'hi' };
    const body = buildFormBody(params);
    // Twilio signed against a different URL than what reconstructSignedUrl returns.
    const sig = signTwilio(AUTH_TOKEN, 'https://other.example.com/path', params);

    const req = makeReq(PUBLIC_URL, body, { 'x-twilio-signature': sig });
    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects when a parameter was added between signing and arrival', async () => {
    // Defends against a MITM that appends a malicious param to the body —
    // sorted-concat changes, signature breaks.
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const signedParams = { From: '+12133734253', Body: 'hi' };
    const sig = signTwilio(AUTH_TOKEN, PUBLIC_URL, signedParams);

    const tamperedBody = buildFormBody({ ...signedParams, Injected: 'evil' });
    const req = makeReq(PUBLIC_URL, tamperedBody, { 'x-twilio-signature': sig });
    const result = await adapter.verify(req, makeCtx(tamperedBody));

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });
});

// ─── normalise() ─────────────────────────────────────────────────────────────

describe('TwilioAdapter.normalise — SMS', () => {
  it('extracts standard SMS fields', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: '+12133734253',
      To: '+12025550100',
      Body: 'Hello there',
      MessageSid: 'SM' + 'a'.repeat(32),
      NumSegments: '1',
    });

    const result = adapter.normalise(null, new Headers(), body);

    expect(result.channel).toBe('twilio');
    expect(result.eventType).toBe('message');
    expect(result.externalId).toBe('SM' + 'a'.repeat(32));
    expect(result.conversationChannel).toBe('sms');
    expect(result.conversationProvider).toBe('twilio');
    expect(result.fromAddress).toBe('+12133734253');
    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.from).toBe('+12133734253');
    expect(payload.to).toBe('+12025550100');
    expect(payload.text).toBe('Hello there');
    expect(payload.subChannel).toBe('sms');
    expect(payload.attachments).toEqual([]);
  });

  it('handles missing Body as empty string', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: '+12133734253',
      MessageSid: 'SM' + 'd'.repeat(32),
    });

    const result = adapter.normalise(null, new Headers(), body);

    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.text).toBe('');
  });
});

describe('TwilioAdapter.normalise — WhatsApp via Twilio', () => {
  it('strips `whatsapp:` prefix and sets subChannel to whatsapp', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: 'whatsapp:+447400123456',
      To: 'whatsapp:+447400999888',
      Body: 'Hello via WA',
      MessageSid: 'SM' + 'b'.repeat(32),
    });

    const result = adapter.normalise(null, new Headers(), body);

    expect(result.conversationChannel).toBe('whatsapp');
    expect(result.fromAddress).toBe('+447400123456');
    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.subChannel).toBe('whatsapp');
    expect(payload.from).toBe('+447400123456');
    expect(payload.to).toBe('+447400999888');
  });
});

describe('TwilioAdapter.normalise — MMS attachments', () => {
  it('extracts attachment URLs and content types', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: '+12133734253',
      Body: 'check these out',
      MessageSid: 'SM' + 'e'.repeat(32),
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC.../Messages/SM.../Media/ME0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC.../Messages/SM.../Media/ME1',
      MediaContentType1: 'image/png',
    });

    const result = adapter.normalise(null, new Headers(), body);

    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.attachments).toHaveLength(2);
    expect(payload.attachments[0]).toEqual({
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC.../Messages/SM.../Media/ME0',
      contentType: 'image/jpeg',
    });
    expect(payload.attachments[1].contentType).toBe('image/png');
  });

  it('handles NumMedia=0 cleanly', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: '+12133734253',
      Body: 'no media',
      MessageSid: 'SM' + 'f'.repeat(32),
      NumMedia: '0',
    });

    const result = adapter.normalise(null, new Headers(), body);
    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.attachments).toEqual([]);
  });

  it('handles malformed NumMedia without throwing', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: '+12133734253',
      Body: 'bogus',
      NumMedia: 'NaN-ish',
    });

    const result = adapter.normalise(null, new Headers(), body);
    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.attachments).toEqual([]);
  });
});

describe('TwilioAdapter.normalise — status callbacks', () => {
  it('marks eventType as status_callback when MessageStatus is present', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      MessageSid: 'SM' + 'g'.repeat(32),
      MessageStatus: 'delivered',
      To: '+12133734253',
      From: '+12025550100',
    });

    const result = adapter.normalise(null, new Headers(), body);

    expect(result.eventType).toBe('status_callback');
    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.status).toBe('delivered');
  });

  it('does NOT set conversation fields on a status callback', () => {
    // Status callbacks for messages WE sent shouldn't create or update
    // a conversation row for the recipient.
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      MessageSid: 'SM' + 'h'.repeat(32),
      MessageStatus: 'delivered',
      To: '+12133734253',
      From: '+12025550100',
    });

    const result = adapter.normalise(null, new Headers(), body);

    expect(result.conversationChannel).toBeUndefined();
    expect(result.conversationProvider).toBeUndefined();
    expect(result.fromAddress).toBeUndefined();
  });

  it('exposes errorCode when delivery failed', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      MessageSid: 'SM' + 'i'.repeat(32),
      MessageStatus: 'failed',
      ErrorCode: '30003',
      To: '+12133734253',
      From: '+12025550100',
    });

    const result = adapter.normalise(null, new Headers(), body);

    const payload = result.payload as unknown as TwilioTriggerPayload;
    expect(payload.status).toBe('failed');
    expect(payload.errorCode).toBe('30003');
  });
});

describe('TwilioAdapter.normalise — invalid phone numbers', () => {
  it('returns empty fromAddress when From is not parseable and skips conversation fields', () => {
    const adapter = new TwilioAdapter(AUTH_TOKEN);
    const body = buildFormBody({
      From: 'not-a-phone',
      Body: 'garbage',
      MessageSid: 'SM' + 'j'.repeat(32),
    });

    const result = adapter.normalise(null, new Headers(), body);

    // Conversation fields gated on `from` being non-empty.
    expect(result.conversationChannel).toBeUndefined();
    expect(result.fromAddress).toBeUndefined();
  });
});
