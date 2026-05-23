/**
 * Unit Tests: Webhook DLQ List Endpoint
 *
 * GET /api/v1/admin/orchestration/webhooks/dlq
 *
 * Test Coverage:
 * - Returns only exhausted deliveries scoped to the calling admin
 * - subscriptionId / eventType / since-until filters thread through
 * - Pagination params are respected
 * - Validation: bad cuid → 400; bad date → 400
 * - Authentication: unauthenticated → 401
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookDelivery: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { GET } from '@/app/api/v1/admin/orchestration/webhooks/dlq/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const SUB_ID = 'cmjbv4i3x00013wslsomesubid';

function makeRequest(qs = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/webhooks/dlq${qs}`,
  } as unknown as NextRequest;
}

describe('GET /webhooks/dlq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0 as never);
  });

  it('returns paginated deliveries scoped to admin and exhausted status', async () => {
    const res = await GET(makeRequest('?page=2&pageSize=5'));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.meta).toMatchObject({ page: 2, limit: 5 });

    // The query MUST be scoped to `status: exhausted` AND the admin's
    // subscriptions — that's the whole point of the DLQ endpoint, so a
    // permissive scope here would be a security regression.
    const call = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({
      status: 'exhausted',
      subscription: { createdBy: ADMIN_ID },
    });
    expect(call?.skip).toBe(5); // (page-1) * pageSize
    expect(call?.take).toBe(5);
  });

  it('applies subscriptionId / eventType / since-until filters', async () => {
    const since = '2026-05-01T00:00:00.000Z';
    const until = '2026-05-20T00:00:00.000Z';
    await GET(
      makeRequest(
        `?subscriptionId=${SUB_ID}&eventType=workflow_failed&since=${since}&until=${until}`
      )
    );

    const call = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({
      subscriptionId: SUB_ID,
      eventType: 'workflow_failed',
    });
    expect((call?.where as Record<string, unknown>).createdAt).toMatchObject({
      gte: new Date(since),
      lt: new Date(until),
    });
  });

  it('returns 400 for an invalid subscriptionId', async () => {
    const res = await GET(makeRequest('?subscriptionId=not-a-cuid'));
    expect(res.status).toBe(400);
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('returns 400 for an unparseable date', async () => {
    const res = await GET(makeRequest('?since=not-a-date'));
    expect(res.status).toBe(400);
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
