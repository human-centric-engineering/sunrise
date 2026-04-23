/**
 * Tests: Event Hook Deliveries List
 *
 * GET /api/v1/admin/orchestration/hooks/:id/deliveries
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findUnique: vi.fn(),
    },
    aiEventHookDelivery: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET as ListDeliveries } from '@/app/api/v1/admin/orchestration/hooks/[id]/deliveries/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const HOOK_ID = 'cmjbv4i3x00003wsloputgwu1';
const DELIVERY_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeHook(overrides: Record<string, unknown> = {}) {
  return { id: HOOK_ID, ...overrides };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: DELIVERY_ID,
    hookId: HOOK_ID,
    eventType: 'conversation.started',
    payload: { eventType: 'conversation.started', data: {} },
    status: 'delivered',
    attempts: 1,
    lastAttemptAt: new Date('2026-04-23'),
    nextRetryAt: null,
    lastResponseCode: 200,
    lastError: null,
    createdAt: new Date('2026-04-23'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(hookId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/hooks/${hookId}/deliveries`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /hooks/:id/deliveries', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await ListDeliveries(makeRequest(HOOK_ID), makeParams(HOOK_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await ListDeliveries(makeRequest(HOOK_ID), makeParams(HOOK_ID));
    expect(response.status).toBe(403);
  });

  it('returns 404 when hook does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    const response = await ListDeliveries(makeRequest(HOOK_ID), makeParams(HOOK_ID));

    expect(response.status).toBe(404);
  });

  it('returns paginated deliveries for a valid hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([makeDelivery()] as never);
    vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(1);

    const response = await ListDeliveries(makeRequest(HOOK_ID), makeParams(HOOK_ID));

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('passes hookId filter to the query', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(0);

    await ListDeliveries(makeRequest(HOOK_ID), makeParams(HOOK_ID));

    expect(prisma.aiEventHookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ hookId: HOOK_ID }),
      })
    );
  });

  it('filters by status when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(0);

    await ListDeliveries(makeRequest(HOOK_ID, { status: 'failed' }), makeParams(HOOK_ID));

    expect(prisma.aiEventHookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'failed' }),
      })
    );
  });

  it('rejects invalid status value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    const response = await ListDeliveries(
      makeRequest(HOOK_ID, { status: 'invalid_status' }),
      makeParams(HOOK_ID)
    );

    expect(response.status).toBe(400);
  });

  it('paginates with custom page and pageSize', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEventHookDelivery.count).mockResolvedValue(50);

    const response = await ListDeliveries(
      makeRequest(HOOK_ID, { page: '2', pageSize: '10' }),
      makeParams(HOOK_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.aiEventHookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    );
  });
});
