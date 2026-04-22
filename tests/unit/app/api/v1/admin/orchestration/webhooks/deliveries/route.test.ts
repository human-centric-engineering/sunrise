/**
 * Tests: Webhook Deliveries List
 *
 * GET /api/v1/admin/orchestration/webhooks/:id/deliveries
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
    aiWebhookSubscription: {
      findUnique: vi.fn(),
    },
    aiWebhookDelivery: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ListDeliveries } from '@/app/api/v1/admin/orchestration/webhooks/[id]/deliveries/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const SUBSCRIPTION_ID = 'cmjbv4i3x00003wsloputgwu1';
const DELIVERY_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIPTION_ID,
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: DELIVERY_ID,
    subscriptionId: SUBSCRIPTION_ID,
    status: 'delivered',
    payload: { event: 'test' },
    responseCode: 200,
    responseBody: 'OK',
    attemptCount: 1,
    createdAt: new Date('2025-01-01'),
    nextRetryAt: null,
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(subscriptionId: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost:3000/api/v1/admin/orchestration/webhooks/${subscriptionId}/deliveries`
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

describe('GET /webhooks/:id/deliveries', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 'session_1',
        userId: 'user_1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: 'user_1',
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(403);
  });

  it('returns 404 when subscription does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(null);

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(404);
  });

  it('returns paginated deliveries for a valid subscription', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([makeDelivery()] as never);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(1);

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(200);

    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('passes subscriptionId filter to the query', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0);

    await ListDeliveries(makeRequest(SUBSCRIPTION_ID), makeParams(SUBSCRIPTION_ID));

    expect(prisma.aiWebhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subscriptionId: SUBSCRIPTION_ID }),
      })
    );
  });

  it('filters by status when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0);

    await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID, { status: 'failed' }),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(prisma.aiWebhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'failed' }),
      })
    );
  });

  it('rejects invalid status value', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID, { status: 'invalid_status' }),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(400);
  });

  it('paginates with custom page and pageSize', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(50);

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID, { page: '2', pageSize: '10' }),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(200);

    expect(prisma.aiWebhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
      })
    );

    const body = await parseJson<{ meta: { totalPages: number } }>(response);
    expect(body.meta.totalPages).toBe(5);
  });

  it('returns empty list when no deliveries exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSubscription() as never
    );
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWebhookDelivery.count).mockResolvedValue(0);

    const response = await ListDeliveries(
      makeRequest(SUBSCRIPTION_ID),
      makeParams(SUBSCRIPTION_ID)
    );

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(0);
  });
});
