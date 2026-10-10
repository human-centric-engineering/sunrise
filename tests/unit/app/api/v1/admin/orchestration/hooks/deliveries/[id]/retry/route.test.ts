/**
 * Tests: Event Hook Delivery Manual Retry
 *
 * POST /api/v1/admin/orchestration/hooks/deliveries/:id/retry
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
  prisma: { aiEventHookDelivery: { findUnique: vi.fn() } },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  retryHookDelivery: vi.fn(),
}));

// The route fire-and-forgets logAdminAction (un-awaited). Without this mock the
// real implementation hits Prisma against a non-existent test DB and its
// `.catch` logger.error() resolves during worker teardown, surfacing as
// "Closing rpc while onUserConsoleLog was pending".
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { retryHookDelivery } from '@/lib/orchestration/hooks/registry';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { POST as RetryDelivery } from '@/app/api/v1/admin/orchestration/hooks/deliveries/[id]/retry/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const DELIVERY_ID = 'cmjbv4i3x00003wsloputgwu2';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(deliveryId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/hooks/deliveries/${deliveryId}/retry`,
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
  // A live delivery by default: its hook still exists.
  vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
    hookId: 'hook-1',
  } as never);
});

describe('POST /hooks/deliveries/:id/retry', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));
    expect(response.status).toBe(403);
  });

  it('looks the delivery up by id, selecting only hookId', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(prisma.aiEventHookDelivery.findUnique).toHaveBeenCalledWith({
      where: { id: DELIVERY_ID },
      select: { hookId: true },
    });
  });

  it('returns 404 and does not retry when the delivery does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(null);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
    const body = await parseJson<{ error: { message: string } }>(response);
    expect(body.error.message).toBe('Hook delivery not found');
    expect(retryHookDelivery).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('returns 409, without retrying or auditing, for an orphaned delivery whose hook was deleted', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({ hookId: null } as never);
    // If the route skipped the check, this would turn the 409 into a 200.
    vi.mocked(retryHookDelivery).mockResolvedValue(true);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(409);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(retryHookDelivery).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('returns 404 when delivery is not found or not retriable', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(false);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
  });

  it('retries a delivery and returns success', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(true);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { retried: boolean; deliveryId: string } }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.retried).toBe(true);
    expect(body.data.deliveryId).toBe(DELIVERY_ID);
  });

  it('calls retryHookDelivery with the correct delivery id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(retryHookDelivery).toHaveBeenCalledWith(DELIVERY_ID);
  });

  it('returns 400 and does not call retryHookDelivery when id is not a valid CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await RetryDelivery(makeRequest('not-a-cuid'), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
    const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Guard must short-circuit BEFORE the registry call; catches regressions where
    // the cuidSchema.safeParse check is moved below retryHookDelivery(id).
    expect(retryHookDelivery).not.toHaveBeenCalled();
  });

  it('writes no audit entry when the hook delivery cannot be retried (deleted hook)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(false);

    const response = await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(response.status).toBe(404);
    expect(retryHookDelivery).toHaveBeenCalledWith(DELIVERY_ID);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('audits a successful hook retry', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(retryHookDelivery).mockResolvedValue(true);

    await RetryDelivery(makeRequest(DELIVERY_ID), makeParams(DELIVERY_ID));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook_delivery.retry',
        entityType: 'delivery',
        entityId: DELIVERY_ID,
      })
    );
  });
});
