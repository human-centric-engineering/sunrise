/**
 * Unit Tests: POST /api/v1/billing/webhook/[provider] (§139 t-1094)
 *
 * What the route adds to `handleBillingWebhook()` (its own tests are
 * `tests/unit/lib/billing/webhook.test.ts`): the raw body reaches it byte for
 * byte, an oversized body or a malformed provider segment is refused before
 * it runs, and each outcome becomes the status the provider acts on: 404 off,
 * 400 bad signature, 200 handled (including a replay and an event naming no
 * org), 500 retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

const mockHandle = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/webhook', () => ({ handleBillingWebhook: mockHandle }));

import { POST } from '@/app/api/v1/billing/webhook/[provider]/route';

function deliver(body: string, provider = 'stripe', headers: HeadersInit = {}) {
  const request = new Request(`http://localhost/api/v1/billing/webhook/${provider}`, {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=abc', ...headers },
    body,
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ provider }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHandle.mockResolvedValue({
    status: 'recorded',
    eventId: 'evt_1',
    orgId: 'org_a',
    outcome: 'applied',
  });
});

describe('POST /api/v1/billing/webhook/[provider]', () => {
  it('hands the handler the body exactly as it arrived, and the headers', async () => {
    // Whitespace and key order a parse-and-reserialise would change.
    const raw = '{ "id":"evt_1",  "type" : "customer.subscription.updated" }\n';

    const res = await deliver(raw);

    expect(res.status).toBe(200);
    const input = mockHandle.mock.calls[0][0] as {
      providerKey: string;
      rawBody: string;
      headers: Headers;
    };
    expect(input.providerKey).toBe('stripe');
    expect(input.rawBody).toBe(raw);
    expect(input.headers.get('stripe-signature')).toBe('t=1,v1=abc');
  });

  it.each([
    [{ status: 'billing_off' }, 404],
    [{ status: 'bad_signature' }, 400],
    [{ status: 'ignored', eventId: 'evt_1', eventType: 'charge.succeeded' }, 200],
    [{ status: 'no_org', eventId: 'evt_1', eventType: 'customer.subscription.deleted' }, 200],
    [{ status: 'replay', eventId: 'evt_1', orgId: 'org_a' }, 200],
    [{ status: 'recorded', eventId: 'evt_1', orgId: 'org_a', outcome: 'not_applied' }, 200],
  ])('answers %o with %i', async (result, status) => {
    mockHandle.mockResolvedValue(result);
    expect((await deliver('{}')).status).toBe(status);
  });

  it('answers 500, so the provider retries, when handling throws, and says nothing of why', async () => {
    mockHandle.mockRejectedValue(new Error('connection to database lost: secret-host'));

    const res = await deliver('{}');

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret-host');
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('refuses a body over 512 KB before handling it', async () => {
    const res = await deliver('x'.repeat(512 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('answers a provider segment that is not a provider key as billing off, before handling', async () => {
    const res = await deliver('{}', 'STRIPE%20x');
    expect(res.status).toBe(404);
    expect(mockHandle).not.toHaveBeenCalled();
  });
});
