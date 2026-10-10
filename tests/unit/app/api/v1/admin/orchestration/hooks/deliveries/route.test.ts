/**
 * Tests: Event Hook Deliveries List (across hooks)
 *
 * GET /api/v1/admin/orchestration/hooks/deliveries
 *
 * The per-hook list 404s once its hook is deleted; this route is the only
 * reader of orphaned deliveries (§109 t-739).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHookDelivery: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET as ListAllDeliveries } from '@/app/api/v1/admin/orchestration/hooks/deliveries/route';

const HOOK_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu2',
    hookId: HOOK_ID,
    eventType: 'conversation.started',
    destination: 'https://hooks.example.com/in',
    status: 'exhausted',
    createdAt: new Date('2026-04-23'),
    ...overrides,
  };
}

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/hooks/deliveries');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function findManyArgs() {
  return vi.mocked(prisma.aiEventHookDelivery.findMany).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(0);
});

describe('GET /hooks/deliveries', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await ListAllDeliveries(makeRequest());

    expect(response.status).toBe(401);
    expect(prisma.aiEventHookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('returns 403 when the user is not an admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await ListAllDeliveries(makeRequest());

    expect(response.status).toBe(403);
    expect(prisma.aiEventHookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('lists across hooks with no filter, newest first, wrapped with pagination meta', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      makeDelivery(),
      makeDelivery({ id: 'cmjbv4i3x00003wsloputgwu3', hookId: null }),
    ] as never);
    vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(42);

    const response = await ListAllDeliveries(makeRequest({ page: '3', pageSize: '10' }));

    expect(response.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: Array<{ hookId: string | null }>;
      meta: { page: number; limit: number; total: number };
    }>(response);
    expect(body.success).toBe(true);
    expect(body.data.map((d) => d.hookId)).toEqual([HOOK_ID, null]);
    expect(body.meta).toMatchObject({ page: 3, limit: 10, total: 42 });
    expect(findManyArgs()).toMatchObject({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 10,
    });
    // The count uses the same where, or the pagination total drifts.
    expect(vi.mocked(prisma.aiEventHookDelivery.count).mock.calls[0][0]).toEqual({ where: {} });
  });

  it('orphaned=true selects deliveries whose hook is gone (hookId null)', async () => {
    await ListAllDeliveries(makeRequest({ orphaned: 'true' }));

    expect(findManyArgs()?.where).toEqual({ hookId: null });
    expect(vi.mocked(prisma.aiEventHookDelivery.count).mock.calls[0][0]?.where).toEqual({
      hookId: null,
    });
  });

  it('orphaned=false without hookId selects only deliveries that still have a hook', async () => {
    await ListAllDeliveries(makeRequest({ orphaned: 'false' }));

    // Not coerced to true: "false" must not select the orphans.
    expect(findManyArgs()?.where).toEqual({ hookId: { not: null } });
  });

  it('orphaned=false with a hookId filters by that hook only', async () => {
    await ListAllDeliveries(makeRequest({ orphaned: 'false', hookId: HOOK_ID }));

    expect(findManyArgs()?.where).toEqual({ hookId: HOOK_ID });
  });

  it('threads status and hookId filters through together', async () => {
    await ListAllDeliveries(makeRequest({ status: 'failed', hookId: HOOK_ID }));

    expect(findManyArgs()?.where).toEqual({ status: 'failed', hookId: HOOK_ID });
  });

  it('combines status with orphaned=true', async () => {
    await ListAllDeliveries(makeRequest({ status: 'exhausted', orphaned: 'true' }));

    expect(findManyArgs()?.where).toEqual({ status: 'exhausted', hookId: null });
  });

  it('returns 400 when hookId and orphaned=true are both set, querying nothing', async () => {
    const response = await ListAllDeliveries(makeRequest({ hookId: HOOK_ID, orphaned: 'true' }));

    expect(response.status).toBe(400);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.aiEventHookDelivery.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['orphaned', { orphaned: 'yes' }],
    ['status', { status: 'bogus' }],
    ['hookId', { hookId: 'not-a-cuid' }],
    ['pageSize', { pageSize: '101' }],
    ['page', { page: '0' }],
  ])('returns 400 for an invalid %s', async (_name, params) => {
    const response = await ListAllDeliveries(makeRequest(params));

    expect(response.status).toBe(400);
    expect(prisma.aiEventHookDelivery.findMany).not.toHaveBeenCalled();
  });
});
