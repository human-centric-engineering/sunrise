/**
 * Unit Tests: Webhook DLQ Bulk Replay
 *
 * POST /api/v1/admin/orchestration/webhooks/dlq/replay
 *
 * Covers:
 * - Body validation (must be deliveryIds-array OR subscriptionId form)
 * - deliveryIds form: only owned ids are retried, returns retried count
 * - subscriptionId form: pulls exhausted rows for that subscription,
 *   honours `before`, scoped to caller's subscriptions
 * - Concurrency cap doesn't drop rows (all reach retryDelivery)
 * - Audit log entry written
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
    aiWebhookDelivery: { findMany: vi.fn() },
    aiWebhookSubscription: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  retryDelivery: vi.fn(),
}));

import { POST } from '@/app/api/v1/admin/orchestration/webhooks/dlq/replay/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const SUB_ID = 'cmjbv4i3x00013wslsubidvalu';

function makeRequest(body: unknown): NextRequest {
  return new Request('http://localhost:3000/api/v1/admin/orchestration/webhooks/dlq/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /webhooks/dlq/replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser() as never);
    vi.mocked(retryDelivery).mockResolvedValue(true);
  });

  it('rejects an empty body', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(retryDelivery).not.toHaveBeenCalled();
  });

  it('replays only delivery ids whose parent subscription the admin owns', async () => {
    // findMany returns the ownership-filtered subset — the third ID was
    // submitted but doesn't belong to this admin so it's dropped.
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { id: 'cmjbv4i3x00003wsldelivone' },
      { id: 'cmjbv4i3x00003wsldelivtwo' },
    ] as never);

    const res = await POST(
      makeRequest({
        deliveryIds: [
          'cmjbv4i3x00003wsldelivone',
          'cmjbv4i3x00003wsldelivtwo',
          'cmjbv4i3x00003wsldelivthr', // not owned
        ],
      })
    );
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(2);
    expect(retryDelivery).toHaveBeenCalledTimes(2);
    // Ownership filter must include the admin's id and the submitted ids.
    expect(prisma.aiWebhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subscription: { createdBy: ADMIN_ID },
        }),
      })
    );
  });

  it('replays every exhausted row for a given subscription, honouring `before`', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue({ id: SUB_ID } as never);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { id: 'cmjbv4i3x00003wsldelivone' },
      { id: 'cmjbv4i3x00003wsldelivtwo' },
      { id: 'cmjbv4i3x00003wsldelivthr' },
    ] as never);

    const before = '2026-05-01T00:00:00.000Z';
    const res = await POST(makeRequest({ subscriptionId: SUB_ID, before }));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(3);
    expect(retryDelivery).toHaveBeenCalledTimes(3);

    const call = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({
      subscriptionId: SUB_ID,
      status: 'exhausted',
      createdAt: { lt: new Date(before) },
    });
  });

  it('returns zero replays when subscriptionId is not owned by caller', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ subscriptionId: SUB_ID }));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(0);
    expect(retryDelivery).not.toHaveBeenCalled();
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('reaches retryDelivery for every targeted row even past the concurrency cap', async () => {
    // 12 rows > REPLAY_CONCURRENCY (5) — guard that the chunking loop
    // doesn't silently lose anything between batches.
    const ids = Array.from({ length: 12 }, (_, i) => ({
      id: `cmjbv4i3x000${String(i).padStart(2, '0')}wsldeliveryid`,
    }));
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue(ids as never);

    const res = await POST(makeRequest({ deliveryIds: ids.map((r) => r.id) }));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(12);
    expect(retryDelivery).toHaveBeenCalledTimes(12);
  });

  it('records replay attempts in the admin audit log', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { id: 'cmjbv4i3x00003wsldelivone' },
    ] as never);

    await POST(makeRequest({ deliveryIds: ['cmjbv4i3x00003wsldelivone'] }));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_delivery.replay_batch',
        metadata: expect.objectContaining({ replayed: 1, skipped: 0 }),
      })
    );
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

    const res = await POST(makeRequest({ deliveryIds: ['cmjbv4i3x00003wsldelivone'] }));
    expect(res.status).toBe(401);
  });

  it('returns the rate-limit response when the limiter rejects the request', async () => {
    const rlResponse = new Response('rate limited', { status: 429 });
    vi.mocked(adminLimiter.check).mockReturnValueOnce({ success: false } as never);
    vi.mocked(createRateLimitResponse).mockReturnValueOnce(rlResponse as never);

    const res = await POST(makeRequest({ deliveryIds: ['cmjbv4i3x00003wsldelivone'] }));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(retryDelivery).not.toHaveBeenCalled();
  });

  it('counts failed retryDelivery calls in the skipped bucket', async () => {
    // Exercises the `(ok ? replayed : skipped).push(id)` else-branch.
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { id: 'cmjbv4i3x00003wsldelivone' },
      { id: 'cmjbv4i3x00003wsldelivtwo' },
    ] as never);
    vi.mocked(retryDelivery).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await POST(
      makeRequest({
        deliveryIds: ['cmjbv4i3x00003wsldelivone', 'cmjbv4i3x00003wsldelivtwo'],
      })
    );
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(1);
    expect(json.data.skipped).toBe(1);
  });

  it('replays subscription rows without a "before" filter when none is supplied', async () => {
    // Exercises the `: {}` branch of `body.before ? ... : ...`. The findMany
    // call shouldn't include a createdAt clause.
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue({ id: SUB_ID } as never);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { id: 'cmjbv4i3x00003wsldelivone' },
    ] as never);

    const res = await POST(makeRequest({ subscriptionId: SUB_ID }));

    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
    expect(call?.where).not.toHaveProperty('createdAt');
  });
});
