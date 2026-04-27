/**
 * Tests: Webhook Delivery Manual Retry
 *
 * POST /api/v1/admin/orchestration/webhooks/deliveries/:id/retry
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

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  retryDelivery: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookDelivery: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { POST as RetryDelivery } from '@/app/api/v1/admin/orchestration/webhooks/deliveries/[id]/retry/route';

const ADMIN_USER_ID = 'cmjbv4i3x00003wsloputgwul';

// ─── Fixtures ───────────────────────────────────────────────────────────

const DELIVERY_ID = 'cmjbv4i3x00003wsloputgwu2';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(deliveryId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/webhooks/deliveries/${deliveryId}/retry`,
    { method: 'POST' }
  );
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

describe('POST /webhooks/deliveries/:id/retry', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

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

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(403);
  });

  it('returns 404 when delivery is not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(null);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
  });

  it('returns 404 when delivery belongs to another admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      subscription: { createdBy: 'other-admin-id' },
    } as never);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
  });

  it('retries a delivery and returns success', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      subscription: { createdBy: ADMIN_USER_ID },
    } as never);
    vi.mocked(retryDelivery).mockResolvedValue(true);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(200);

    const body = await parseJson<{ data: { retried: boolean; deliveryId: string } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.retried).toBe(true);
    expect(body.data.deliveryId).toBe(DELIVERY_ID);
  });

  it('calls retryDelivery with the correct delivery id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      subscription: { createdBy: ADMIN_USER_ID },
    } as never);
    vi.mocked(retryDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(retryDelivery).toHaveBeenCalledWith(DELIVERY_ID);
  });

  it('returns 400 for invalid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await RetryDelivery(makeRequest('not-a-cuid'), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
  });

  it('logs admin audit action on successful retry', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      subscription: { createdBy: ADMIN_USER_ID },
    } as never);
    vi.mocked(retryDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_delivery.retry',
        entityType: 'delivery',
        entityId: DELIVERY_ID,
      })
    );
  });

  it('returns 404 when retryDelivery returns false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      subscription: { createdBy: ADMIN_USER_ID },
    } as never);
    vi.mocked(retryDelivery).mockResolvedValue(false);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
  });
});
