/**
 * Tests: WhatsAppCloudAdapter — HMAC-SHA256 hex verification + GET
 * verify-token handshake + nested webhook envelope normalisation.
 *
 * @see lib/orchestration/inbound/adapters/whatsapp-cloud.ts
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { WhatsAppCloudAdapter } from '@/lib/orchestration/inbound/adapters/whatsapp-cloud';
import type { WhatsAppCloudTriggerPayload } from '@/lib/orchestration/inbound/adapters/whatsapp-cloud';
import type { VerifyContext } from '@/lib/orchestration/inbound/types';

const VERIFY_TOKEN = 'verify-token-xyz';
const APP_SECRET = 'meta-app-secret-abc';
const POST_URL = 'https://app.example.com/api/v1/inbound/whatsapp_cloud/replies';

function signBody(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makePostReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(POST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function makeGetReq(qs: string): NextRequest {
  return new NextRequest(`${POST_URL}?${qs}`, { method: 'GET' });
}

function makeCtx(rawBody: string): VerifyContext {
  return { signingSecret: null, metadata: {}, rawBody };
}

// ─── handleVerificationGet() ─────────────────────────────────────────────────

describe('WhatsAppCloudAdapter.handleVerificationGet', () => {
  const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);

  it('echoes the challenge as plain text 200 on valid handshake', async () => {
    const req = makeGetReq(
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-abc`
    );

    const result = adapter.handleVerificationGet(req);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.headers.get('content-type')).toContain('text/plain');
    await expect(result!.text()).resolves.toBe('challenge-abc');
  });

  it('returns 403 when verify_token is wrong (constant-time compare)', () => {
    const req = makeGetReq(
      'hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-abc'
    );

    const result = adapter.handleVerificationGet(req);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns 403 when verify_token is correct prefix but wrong length (timing-safe)', () => {
    // Same prefix as the real token but shorter. Constant-time compare
    // returns false on length mismatch.
    const req = makeGetReq(
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN.slice(0, 5)}&hub.challenge=ch`
    );

    const result = adapter.handleVerificationGet(req);
    expect(result!.status).toBe(403);
  });

  it('returns null when mode is not subscribe (fall through to GET 405)', () => {
    const req = makeGetReq(
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ch`
    );
    expect(adapter.handleVerificationGet(req)).toBeNull();
  });

  it('returns null when challenge param is missing', () => {
    const req = makeGetReq(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`);
    expect(adapter.handleVerificationGet(req)).toBeNull();
  });
});

// ─── verify() POST ───────────────────────────────────────────────────────────

describe('WhatsAppCloudAdapter.verify — valid signature', () => {
  it('accepts a correctly-signed body', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const body = JSON.stringify({ entry: [{ changes: [{ value: {} }] }] });
    const sig = signBody(APP_SECRET, body);
    const req = makePostReq(body, { 'x-hub-signature-256': sig });

    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: true });
  });
});

describe('WhatsAppCloudAdapter.verify — rejection paths', () => {
  it('rejects when header is missing', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const body = '{"entry":[]}';
    const req = makePostReq(body);

    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('rejects when app secret is empty', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, '');
    const body = '{"entry":[]}';
    const req = makePostReq(body, { 'x-hub-signature-256': 'sha256=deadbeef' });

    const result = await adapter.verify(req, makeCtx(body));

    expect(result).toEqual({ valid: false, reason: 'missing_secret_config' });
  });

  it('rejects when prefix is missing', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const body = '{}';
    const sig = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const req = makePostReq(body, { 'x-hub-signature-256': sig });

    const result = await adapter.verify(req, makeCtx(body));
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects when hex digest contains non-hex characters', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const body = '{}';
    const req = makePostReq(body, { 'x-hub-signature-256': 'sha256=not-hex-zzz' });

    const result = await adapter.verify(req, makeCtx(body));
    expect(result).toEqual({ valid: false, reason: 'bad_format' });
  });

  it('rejects on wrong signature for the body', async () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const body = '{"entry":[]}';
    // Sign a DIFFERENT body, send original — signature mismatch.
    const sig = signBody(APP_SECRET, '{"entry":[{}]}');
    const req = makePostReq(body, { 'x-hub-signature-256': sig });

    const result = await adapter.verify(req, makeCtx(body));
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });
});

// ─── normalise() ─────────────────────────────────────────────────────────────

describe('WhatsAppCloudAdapter.normalise — text messages', () => {
  it('extracts text message fields and sets conversation key', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const envelope = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  display_phone_number: '447400999888',
                  phone_number_id: 'PHONE_NUMBER_ID_123',
                },
                messages: [
                  {
                    id: 'wamid.HBgL' + 'A'.repeat(20),
                    from: '447400123456',
                    timestamp: '1714000000',
                    type: 'text',
                    text: { body: 'Hello from Meta' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.normalise(envelope, new Headers());

    expect(result.channel).toBe('whatsapp_cloud');
    expect(result.eventType).toBe('message');
    expect(result.externalId).toBe('wamid.HBgL' + 'A'.repeat(20));
    expect(result.conversationChannel).toBe('whatsapp');
    expect(result.conversationProvider).toBe('meta');
    // Meta sends number without leading +; helper normalises.
    expect(result.fromAddress).toBe('+447400123456');

    const payload = result.payload as unknown as WhatsAppCloudTriggerPayload;
    expect(payload.text).toBe('Hello from Meta');
    expect(payload.toPhoneNumberId).toBe('PHONE_NUMBER_ID_123');
    expect(payload.subChannel).toBe('whatsapp');
    expect(payload.attachment).toBeNull();
  });
});

describe('WhatsAppCloudAdapter.normalise — media attachments', () => {
  it('extracts image attachment with caption used as text', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const envelope = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PNID' },
                messages: [
                  {
                    id: 'wamid.img1',
                    from: '447400123456',
                    type: 'image',
                    image: {
                      id: 'media-id-xyz',
                      mime_type: 'image/jpeg',
                      caption: 'check this',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.normalise(envelope, new Headers());

    const payload = result.payload as unknown as WhatsAppCloudTriggerPayload;
    expect(payload.text).toBe('check this');
    expect(payload.attachment).toEqual({
      mediaId: 'media-id-xyz',
      mimeType: 'image/jpeg',
      caption: 'check this',
      filename: '',
    });
  });

  it('extracts document attachment with filename', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const envelope = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PNID' },
                messages: [
                  {
                    id: 'wamid.doc1',
                    from: '447400123456',
                    type: 'document',
                    document: {
                      id: 'doc-media-id',
                      mime_type: 'application/pdf',
                      filename: 'lease.pdf',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.normalise(envelope, new Headers());

    const payload = result.payload as unknown as WhatsAppCloudTriggerPayload;
    expect(payload.attachment?.filename).toBe('lease.pdf');
    expect(payload.attachment?.mimeType).toBe('application/pdf');
  });
});

describe('WhatsAppCloudAdapter.normalise — status events', () => {
  it('marks status events as eventType="status" with no conversation fields', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const envelope = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PNID' },
                statuses: [
                  { id: 'wamid.outbound1', status: 'delivered', recipient_id: '447400123456' },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.normalise(envelope, new Headers());

    expect(result.eventType).toBe('status');
    expect(result.conversationChannel).toBeUndefined();
    expect(result.conversationProvider).toBeUndefined();
    expect(result.fromAddress).toBeUndefined();
  });
});

describe('WhatsAppCloudAdapter.normalise — edge cases', () => {
  it('handles a malformed envelope without throwing', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const result = adapter.normalise({}, new Headers());

    expect(result.channel).toBe('whatsapp_cloud');
    expect(result.eventType).toBe('unknown');
    expect(result.fromAddress).toBeUndefined();
  });

  it('handles null body gracefully', () => {
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const result = adapter.normalise(null, new Headers());
    expect(result.channel).toBe('whatsapp_cloud');
    expect(result.eventType).toBe('unknown');
  });

  it('takes the first message when multiple are present in one webhook', () => {
    // v1 contract: one message per webhook. Multiple-message webhooks are
    // rare but possible; we normalise the first and ignore the rest.
    // Future enhancement: batch-explode in the route layer.
    const adapter = new WhatsAppCloudAdapter(VERIFY_TOKEN, APP_SECRET);
    const envelope = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.first',
                    from: '447400123456',
                    type: 'text',
                    text: { body: 'first' },
                  },
                  {
                    id: 'wamid.second',
                    from: '447400999888',
                    type: 'text',
                    text: { body: 'second' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.normalise(envelope, new Headers());
    const payload = result.payload as unknown as WhatsAppCloudTriggerPayload;
    expect(payload.text).toBe('first');
    expect(result.externalId).toBe('wamid.first');
  });
});
