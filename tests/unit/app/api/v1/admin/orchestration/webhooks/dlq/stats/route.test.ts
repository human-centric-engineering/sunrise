/**
 * Unit Tests: Webhook DLQ Stats Endpoint
 *
 * GET /api/v1/admin/orchestration/webhooks/dlq/stats
 *
 * Test Coverage:
 * - Returns exhausted24h / exhaustedTotal / oldestExhaustedAt
 * - All three queries are scoped to caller's subscriptions + exhausted status
 * - 24h count uses a createdAt >= now-24h filter
 * - Empty state: zero rows ⇒ all zeros + null oldest
 * - 401 unauthenticated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookDelivery: { count: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { GET } from '@/app/api/v1/admin/orchestration/webhooks/dlq/stats/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/webhooks/dlq/stats',
  } as unknown as NextRequest;
}

describe('GET /webhooks/dlq/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
  });

  it('returns counts + oldest timestamp scoped to caller subscriptions', async () => {
    const oldest = new Date('2026-04-15T08:00:00.000Z');
    vi.mocked(prisma.aiWebhookDelivery.count)
      .mockResolvedValueOnce(7 as never) // exhausted24h
      .mockResolvedValueOnce(42 as never); // exhaustedTotal
    vi.mocked(prisma.aiWebhookDelivery.findFirst).mockResolvedValue({ createdAt: oldest } as never);

    const res = await GET(makeRequest());
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      exhausted24h: 7,
      exhaustedTotal: 42,
      oldestExhaustedAt: oldest.toISOString(),
    });

    // All three queries must include the exhausted + ownership scope —
    // if any one slips that's a cross-tenant data leak.
    const countCalls = vi.mocked(prisma.aiWebhookDelivery.count).mock.calls;
    expect(countCalls[0][0]?.where).toMatchObject({
      status: 'exhausted',
      subscription: { createdBy: ADMIN_ID },
    });
    expect(countCalls[1][0]?.where).toMatchObject({
      status: 'exhausted',
      subscription: { createdBy: ADMIN_ID },
    });
    const findCall = vi.mocked(prisma.aiWebhookDelivery.findFirst).mock.calls[0][0];
    expect(findCall?.where).toMatchObject({
      status: 'exhausted',
      subscription: { createdBy: ADMIN_ID },
    });
  });

  it('limits the 24h count to deliveries created in the last day', async () => {
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.aiWebhookDelivery.findFirst).mockResolvedValue(null);
    const before = Date.now();

    await GET(makeRequest());

    const firstCount = vi.mocked(prisma.aiWebhookDelivery.count).mock.calls[0][0];
    const gte = (firstCount?.where as Record<string, { gte: Date }>).createdAt.gte;
    expect(gte).toBeInstanceOf(Date);
    // Should be ~24h before now (allow a wide tolerance for test runtime).
    const diff = before - gte.getTime();
    expect(diff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5_000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
  });

  it('returns zeros and null oldest when no exhausted rows exist', async () => {
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.aiWebhookDelivery.findFirst).mockResolvedValue(null);

    const res = await GET(makeRequest());
    const json = JSON.parse(await res.text());

    expect(json.data).toEqual({
      exhausted24h: 0,
      exhaustedTotal: 0,
      oldestExhaustedAt: null,
    });
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
  });

  it('returns the rate-limit response when the limiter rejects the request', async () => {
    const rlResponse = new Response('rate limited', { status: 429 });
    vi.mocked(adminLimiter.check).mockReturnValueOnce({ success: false } as never);
    vi.mocked(createRateLimitResponse).mockReturnValueOnce(rlResponse as never);

    const res = await GET(makeRequest());

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(prisma.aiWebhookDelivery.count).not.toHaveBeenCalled();
  });
});
