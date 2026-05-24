/**
 * Tests: TwilioOutboundAdapter — SMS + WhatsApp dispatch + auth header
 * build + error mapping.
 *
 * Mocks `executeHttpRequest` so we can assert the exact URL, body, and
 * Authorization header without hitting the network. Mocks
 * `resolveEnvTemplate` so we exercise the env-var-unset failure mode
 * without polluting process.env.
 *
 * @see lib/orchestration/outbound/adapters/twilio.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/http', () => ({
  executeHttpRequest: vi.fn(),
}));

import { executeHttpRequest } from '@/lib/orchestration/http';
import { TwilioOutboundAdapter } from '@/lib/orchestration/outbound/adapters/twilio';
import {
  OutboundSendError,
  type ConversationContext,
  type OutboundMessageRequest,
} from '@/lib/orchestration/outbound/types';

const ENV_SNAPSHOT = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'auth-token-secret';
});

afterEach(() => {
  process.env = { ...ENV_SNAPSHOT };
});

function makeConv(provider: string = 'twilio'): ConversationContext {
  return {
    id: 'conv-1',
    channel: 'sms',
    provider,
    fromAddress: '+12133734253',
    lastInboundAt: new Date(),
  };
}

function baseConfig() {
  return {
    accountSidEnv: 'TWILIO_ACCOUNT_SID',
    authTokenEnv: 'TWILIO_AUTH_TOKEN',
    fromNumberSms: '+12025550100',
    fromNumberWhatsapp: '+14155550100',
    costPerMessageUsd: 0.0075,
  };
}

function makeReq(overrides: Partial<OutboundMessageRequest> = {}): OutboundMessageRequest {
  return {
    to: '+12133734253',
    channel: 'sms',
    body: 'hello',
    idempotencyKey: 'dedup-1',
    ...overrides,
  };
}

// ─── Successful dispatch ─────────────────────────────────────────────────────

describe('TwilioOutboundAdapter.send — SMS', () => {
  it('POSTs to the correct Twilio URL with Basic auth header + form body', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 201,
      body: { sid: 'SMabc123', status: 'queued' },
      latencyMs: 42,
    });

    const adapter = new TwilioOutboundAdapter();
    const result = await adapter.send(makeReq(), makeConv(), baseConfig());

    expect(result).toEqual({
      transactionId: 'SMabc123',
      statusCode: 201,
      vendorRaw: { sid: 'SMabc123', status: 'queued' },
    });

    expect(executeHttpRequest).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeHttpRequest).mock.calls[0][0];
    expect(call.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`
    );
    expect(call.method).toBe('POST');
    expect(call.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    // Basic auth — base64(sid:token)
    const expectedB64 = Buffer.from(`AC${'a'.repeat(32)}:auth-token-secret`).toString('base64');
    expect(call.headers?.authorization).toBe(`Basic ${expectedB64}`);
    // Form body
    const form = new URLSearchParams(call.body as string);
    expect(form.get('From')).toBe('+12025550100');
    expect(form.get('To')).toBe('+12133734253');
    expect(form.get('Body')).toBe('hello');
    expect(call.auth).toEqual({ type: 'none' });
  });
});

describe('TwilioOutboundAdapter.send — WhatsApp', () => {
  it('uses WhatsApp From number and adds `whatsapp:` prefix to both addresses', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 201,
      body: { sid: 'SMwa1' },
      latencyMs: 50,
    });

    const adapter = new TwilioOutboundAdapter();
    await adapter.send(
      makeReq({ channel: 'whatsapp', to: '+447400123456' }),
      { ...makeConv(), channel: 'whatsapp' },
      baseConfig()
    );

    const call = vi.mocked(executeHttpRequest).mock.calls[0][0];
    const form = new URLSearchParams(call.body as string);
    expect(form.get('From')).toBe('whatsapp:+14155550100');
    expect(form.get('To')).toBe('whatsapp:+447400123456');
  });
});

// ─── Config / env-var failures ───────────────────────────────────────────────

describe('TwilioOutboundAdapter.send — config + env failures', () => {
  it('throws config_invalid when accountSidEnv is missing', async () => {
    const adapter = new TwilioOutboundAdapter();
    const badConfig = { ...baseConfig(), accountSidEnv: '' };

    await expect(adapter.send(makeReq(), makeConv(), badConfig)).rejects.toMatchObject({
      name: 'OutboundSendError',
      code: 'config_invalid',
    });
  });

  it('throws config_invalid when the SID env var is not set in process.env', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;

    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      name: 'OutboundSendError',
      code: 'config_invalid',
    });
  });

  it('throws config_invalid when fromNumberSms missing for SMS dispatch', async () => {
    const adapter = new TwilioOutboundAdapter();
    const cfg = { ...baseConfig(), fromNumberSms: undefined };

    await expect(adapter.send(makeReq({ channel: 'sms' }), makeConv(), cfg)).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });

  it('throws config_invalid when fromNumberWhatsapp missing for WA dispatch', async () => {
    const adapter = new TwilioOutboundAdapter();
    const cfg = { ...baseConfig(), fromNumberWhatsapp: undefined };

    await expect(
      adapter.send(makeReq({ channel: 'whatsapp' }), { ...makeConv(), channel: 'whatsapp' }, cfg)
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });
});

// ─── Vendor error mapping ────────────────────────────────────────────────────

describe('TwilioOutboundAdapter.send — vendor error mapping', () => {
  it('401 → vendor_unauthorized', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 401,
      body: { message: 'auth failed' },
      latencyMs: 30,
    });
    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_unauthorized',
      statusCode: 401,
    });
  });

  it('429 → vendor_rate_limited', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 429,
      body: { message: 'rate limited' },
      latencyMs: 5,
    });
    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_rate_limited',
      statusCode: 429,
    });
  });

  it('502 → vendor_unavailable', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 502,
      body: { message: 'bad gateway' },
      latencyMs: 10,
    });
    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_unavailable',
      statusCode: 502,
    });
  });

  it('400 → vendor_rejected', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 400,
      body: { error_message: 'invalid recipient' },
      latencyMs: 10,
    });
    const adapter = new TwilioOutboundAdapter();
    const promise = adapter.send(makeReq(), makeConv(), baseConfig());
    await expect(promise).rejects.toMatchObject({ code: 'vendor_rejected', statusCode: 400 });
    await expect(promise).rejects.toThrow(/invalid recipient/);
  });

  it('200 without sid → vendor_rejected', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 200,
      body: { status: 'queued' /* no sid */ },
      latencyMs: 5,
    });
    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toMatchObject({
      code: 'vendor_rejected',
    });
  });
});

describe('TwilioOutboundAdapter shape', () => {
  it('declares the correct provider slug + channels', () => {
    const a = new TwilioOutboundAdapter();
    expect(a.provider).toBe('twilio');
    expect(a.supportedChannels).toEqual(['sms', 'whatsapp']);
  });

  it('throws OutboundSendError (typed) on failure', async () => {
    vi.mocked(executeHttpRequest).mockResolvedValue({
      status: 401,
      body: {},
      latencyMs: 5,
    });
    const adapter = new TwilioOutboundAdapter();
    await expect(adapter.send(makeReq(), makeConv(), baseConfig())).rejects.toBeInstanceOf(
      OutboundSendError
    );
  });
});
