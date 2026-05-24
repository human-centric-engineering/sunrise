/**
 * Tests: MetaWhatsAppOutboundAdapter — text + template dispatch + error
 * mapping. Mocks `executeHttpRequest`.
 *
 * @see lib/orchestration/outbound/adapters/whatsapp-cloud.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/http', () => ({
  executeHttpRequest: vi.fn(),
}));

import { executeHttpRequest } from '@/lib/orchestration/http';
import { MetaWhatsAppOutboundAdapter } from '@/lib/orchestration/outbound/adapters/whatsapp-cloud';
import {
  OutboundSendError,
  type ConversationContext,
  type OutboundMessageRequest,
} from '@/lib/orchestration/outbound/types';

const ENV_SNAPSHOT = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_ACCESS_TOKEN = 'meta-access-token-xyz';
});

afterEach(() => {
  process.env = { ...ENV_SNAPSHOT };
});

function makeConv(): ConversationContext {
  return {
    id: 'conv-1',
    channel: 'whatsapp',
    provider: 'meta',
    fromAddress: '+447400123456',
    lastInboundAt: new Date(),
  };
}

function baseConfig() {
  return {
    accessTokenEnv: 'WHATSAPP_ACCESS_TOKEN',
    phoneNumberId: 'PHONE_NUMBER_ID_123',
    costPerMessageUsd: 0.005,
  };
}

function makeReq(overrides: Partial<OutboundMessageRequest> = {}): OutboundMessageRequest {
  return {
    to: '+447400123456',
    channel: 'whatsapp',
    body: 'hello from meta',
    idempotencyKey: 'dedup-1',
    ...overrides,
  };
}

describe('MetaWhatsAppOutboundAdapter.send — text', () => {
  it('POSTs to Graph endpoint with bearer auth and text body', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: '447400123456' }],
        messages: [{ id: 'wamid.outbound1' }],
      },
      latencyMs: 70,
    });

    const adapter = new MetaWhatsAppOutboundAdapter();
    const result = await adapter.send(makeReq(), makeConv(), baseConfig());

    expect(result.transactionId).toBe('wamid.outbound1');
    expect(result.statusCode).toBe(200);

    const call = vi.mocked(executeHttpRequest).mock.calls[0][0];
    expect(call.url).toBe('https://graph.facebook.com/v20.0/PHONE_NUMBER_ID_123/messages');
    expect(call.method).toBe('POST');
    expect(call.headers?.['content-type']).toBe('application/json');
    expect(call.auth).toEqual({ type: 'bearer', secret: 'WHATSAPP_ACCESS_TOKEN' });

    const body = JSON.parse(call.body as string);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '447400123456', // leading + stripped — Meta wants no plus
      type: 'text',
      text: { body: 'hello from meta' },
    });
  });
});

describe('MetaWhatsAppOutboundAdapter.send — template (24h window expired)', () => {
  it('sends a template payload when req.template is provided', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 200,
      body: { messages: [{ id: 'wamid.template1' }] },
      latencyMs: 70,
    });

    const adapter = new MetaWhatsAppOutboundAdapter();
    await adapter.send(
      makeReq({
        template: {
          name: 'appointment_reminder',
          languageCode: 'en_GB',
          components: [{ type: 'body', parameters: [{ type: 'text', text: 'Friday 10am' }] }],
        },
      }),
      makeConv(),
      baseConfig()
    );

    const call = vi.mocked(executeHttpRequest).mock.calls[0][0];
    const body = JSON.parse(call.body as string);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('appointment_reminder');
    expect(body.template.language).toEqual({ code: 'en_GB' });
    expect(body.template.components).toHaveLength(1);
  });
});

describe('MetaWhatsAppOutboundAdapter.send — channel safety', () => {
  it('rejects SMS dispatch attempts', async () => {
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(
      adapter.send(makeReq({ channel: 'sms' }), { ...makeConv(), channel: 'sms' }, baseConfig())
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('declares only whatsapp as supported', () => {
    const a = new MetaWhatsAppOutboundAdapter();
    expect(a.supportedChannels).toEqual(['whatsapp']);
  });
});

describe('MetaWhatsAppOutboundAdapter.send — config + env failures', () => {
  it('throws config_invalid when access token env var is missing', async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });

  it('throws config_invalid when phoneNumberId is empty', async () => {
    const adapter = new MetaWhatsAppOutboundAdapter();
    const cfg = { ...baseConfig(), phoneNumberId: '' };
    await expect(adapter.send(makeReq(), makeConv(), cfg)).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });
});

describe('MetaWhatsAppOutboundAdapter.send — vendor error mapping', () => {
  it('401 → vendor_unauthorized', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 401,
      body: { error: { message: 'invalid token', code: 190 } },
      latencyMs: 10,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_unauthorized',
    });
  });

  it('429 → vendor_rate_limited', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 429,
      body: { error: { message: 'rate limit' } },
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_rate_limited',
    });
  });

  it('500 → vendor_unavailable', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 500,
      body: { error: { message: 'internal' } },
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_unavailable',
    });
  });

  it('200 without message id → vendor_rejected', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 200,
      body: { messaging_product: 'whatsapp' /* no messages[] */ },
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toBeInstanceOf(
      OutboundSendError
    );
  });

  it('falls back to default error message when vendor body has no `error.message` or top-level `message`', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 400,
      body: { error: { code: 12345 } }, // error present but no `message` string
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toThrow(
      /Meta dispatch failed: HTTP 400/
    );
  });

  it('falls back to default error message when vendor body is not an object', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 503,
      body: 'plain string body',
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toThrow(
      /Meta dispatch failed: HTTP 503/
    );
  });

  it('falls back to default error message when vendor body has null error field', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 502,
      body: { error: null },
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toThrow(
      /Meta dispatch failed: HTTP 502/
    );
  });

  it('reads top-level `message` when `error` is absent', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 400,
      body: { message: 'plain error message at top level' },
      latencyMs: 5,
    });
    const adapter = new MetaWhatsAppOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toThrow(
      /plain error message at top level/
    );
  });
});

describe('MetaWhatsAppOutboundAdapter.send — `to` normalisation', () => {
  it('passes through a `to` that already lacks a leading + verbatim', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 200,
      body: { messages: [{ id: 'wamid.noplus' }] },
      latencyMs: 5,
    });

    const adapter = new MetaWhatsAppOutboundAdapter();
    await adapter.send(
      makeReq({ to: '447400123456' }), // no leading +
      makeConv(),
      baseConfig()
    );

    const call = vi.mocked(executeHttpRequest).mock.calls[0][0];
    const body = JSON.parse(call.body as string);
    expect(body.to).toBe('447400123456'); // unchanged, no double-strip
  });
});
