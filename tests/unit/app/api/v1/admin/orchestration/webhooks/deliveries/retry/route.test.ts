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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { POST as RetryDelivery } from '@/app/api/v1/admin/orchestration/webhooks/deliveries/[id]/retry/route';

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
    vi.mocked(retryDelivery).mockResolvedValue(false);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
  });

  it('retries a delivery and returns success', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
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
    vi.mocked(retryDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(retryDelivery).toHaveBeenCalledWith(DELIVERY_ID);
  });
});
