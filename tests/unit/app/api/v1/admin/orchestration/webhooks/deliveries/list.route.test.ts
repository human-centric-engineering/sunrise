/**
 * Unit Tests: Webhook Deliveries List Across Subscriptions
 *
 * GET /api/v1/admin/orchestration/webhooks/deliveries
 *
 * (The sibling `route.test.ts` covers `/webhooks/:id/deliveries`.)
 *
 * Test Coverage:
 * - Visibility fragment is AND-composed with status / subscription / orphan filters
 * - orphaned=true / false / subscriptionId combinations
 * - subscriptionId + orphaned=true is a 400 and runs no query
 * - Policy refusing unattributed reads drops the orphan arm
 * - Subscription url is never selected
 * - 401 / 403
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

import { GET } from '@/app/api/v1/admin/orchestration/webhooks/deliveries/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const SUB_ID = 'cmjbv4i3x00013wslsomesubid';

const VISIBLE = { OR: [{ subscription: { createdBy: ADMIN_ID } }, { subscriptionId: null }] };

function makeRequest(qs = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/webhooks/deliveries${qs}`,
  } as unknown as NextRequest;
}

function findManyCall() {
  return vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
}

describe('GET /webhooks/deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0);
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  it('paginates, orders newest first, and AND-composes visibility with an empty filter set', async () => {
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(41);

    const res = await GET(makeRequest('?page=3&pageSize=10'));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({ page: 3, limit: 10, total: 41 });
    const call = findManyCall();
    expect(call?.where).toEqual({ AND: [VISIBLE, {}] });
    expect(call?.skip).toBe(20);
    expect(call?.take).toBe(10);
    expect(call?.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('applies the status filter in every status, not only exhausted', async () => {
    await GET(makeRequest('?status=delivered'));

    expect(findManyCall()?.where).toEqual({ AND: [VISIBLE, { status: 'delivered' }] });
  });

  it('orphaned=true selects only deliveries with no subscription', async () => {
    await GET(makeRequest('?orphaned=true'));

    expect(findManyCall()?.where).toEqual({ AND: [VISIBLE, { subscriptionId: null }] });
  });

  it('orphaned=false excludes deliveries with no subscription', async () => {
    await GET(makeRequest('?orphaned=false'));

    expect(findManyCall()?.where).toEqual({
      AND: [VISIBLE, { subscriptionId: { not: null } }],
    });
  });

  it('subscriptionId alone filters to that subscription', async () => {
    await GET(makeRequest(`?subscriptionId=${SUB_ID}`));

    expect(findManyCall()?.where).toEqual({ AND: [VISIBLE, { subscriptionId: SUB_ID }] });
  });

  it('subscriptionId + orphaned=false keeps the subscription (not overridden by "not null")', async () => {
    await GET(makeRequest(`?subscriptionId=${SUB_ID}&orphaned=false`));

    expect(findManyCall()?.where).toEqual({ AND: [VISIBLE, { subscriptionId: SUB_ID }] });
  });

  it('rejects subscriptionId + orphaned=true with 400 and runs no query', async () => {
    const res = await GET(makeRequest(`?subscriptionId=${SUB_ID}&orphaned=true`));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
    expect(prisma.aiWebhookDelivery.count).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid subscriptionId', '?subscriptionId=not-a-cuid'],
    ['an unknown status', '?status=bogus'],
    ['a non-literal orphaned value', '?orphaned=1'],
    ['pageSize over the cap', '?pageSize=101'],
  ])('returns 400 for %s', async (_label, qs) => {
    const res = await GET(makeRequest(qs));

    expect(res.status).toBe(400);
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('uses the identical where for count and findMany', async () => {
    await GET(makeRequest(`?status=failed&subscriptionId=${SUB_ID}`));

    const countCall = vi.mocked(prisma.aiWebhookDelivery.count).mock.calls[0][0];
    expect(countCall?.where).toEqual(findManyCall()?.where);
  });

  it('drops the orphan arm for both queries when the policy refuses unattributed reads', async () => {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed'
          ? Promise.resolve(false)
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });

    const res = await GET(makeRequest('?status=pending'));

    expect(res.status).toBe(200);
    const expected = {
      AND: [{ subscription: { createdBy: ADMIN_ID } }, { status: 'pending' }],
    };
    expect(findManyCall()?.where).toEqual(expected);
    expect(vi.mocked(prisma.aiWebhookDelivery.count).mock.calls[0][0]?.where).toEqual(expected);
    expect(JSON.stringify(findManyCall()?.where)).not.toContain('"OR"');
  });

  it('does not select the subscription url, which can carry a credential', async () => {
    await GET(makeRequest());

    const call = findManyCall();
    expect(call?.include).toEqual({ subscription: { select: { id: true, description: true } } });
    expect(JSON.stringify(call?.include)).not.toContain('url');
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(prisma.aiWebhookDelivery.findMany).not.toHaveBeenCalled();
  });
});
