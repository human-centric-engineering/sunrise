/**
 * Tests: Webhook Subscription Detail Endpoints
 *
 * GET    /api/v1/admin/orchestration/webhooks/:id
 * PATCH  /api/v1/admin/orchestration/webhooks/:id
 * DELETE /api/v1/admin/orchestration/webhooks/:id
 *
 * Test Coverage:
 * - GET: returns 401 unauthenticated, 404 not found, 400 invalid CUID, 200 success
 * - GET: secret field never exposed in response
 * - GET: ownership scope (createdBy) enforced
 * - PATCH: returns 404 not found, updates and returns data, calls logAdminAction
 * - PATCH: returns 400 invalid CUID, returns 429 rate limited
 * - DELETE: returns 404 not found, deletes and returns { deleted: true }, calls logAdminAction
 * - DELETE: returns 400 invalid CUID, returns 429 rate limited
 *
 * @see app/api/v1/admin/orchestration/webhooks/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

vi.mock('@/lib/api/validation', () => ({
  validateRequestBody: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { validateRequestBody } from '@/lib/api/validation';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/webhooks/[id]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    url: 'https://example.com/webhook',
    events: ['execution_completed'],
    isActive: true,
    description: 'Test webhook',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(id = WEBHOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/webhooks/${id}`);
}

function makePatchRequest(body: Record<string, unknown>, id = WEBHOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/webhooks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(id = WEBHOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/webhooks/${id}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /webhooks/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for an invalid CUID', async () => {
    // Act
    const response = await GET(makeGetRequest('not-a-cuid'), makeParams('not-a-cuid'));

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiWebhookSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

    // Act
    const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(404);
  });

  it('returns 200 with webhook data on success', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);

    // Act
    const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(WEBHOOK_ID);
    expect(body.data.url).toBe('https://example.com/webhook');
    expect(body.data.events).toEqual(['execution_completed']);
    expect(body.data.isActive).toBe(true);
  });

  it('scopes the lookup to the authenticated user (createdBy)', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);

    // Act
    await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

    // Assert: query must include both the id and the owner scope
    expect(prisma.aiWebhookSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: WEBHOOK_ID,
          createdBy: ADMIN_ID,
        }),
      })
    );
  });

  it('queries with SAFE_SELECT that excludes secret', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);

    // Act
    await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

    // Assert: findFirst must be called with a select clause that does NOT include secret
    const callArg = vi.mocked(prisma.aiWebhookSubscription.findFirst).mock.calls[0]?.[0];
    expect(callArg).toHaveProperty('select');
    expect(callArg?.select).not.toHaveProperty('secret');
    // Verify key safe fields ARE selected
    expect(callArg?.select).toMatchObject({
      id: true,
      url: true,
      events: true,
      isActive: true,
    });
  });
});

describe('PATCH /webhooks/:id', () => {
  const updatePayload = { isActive: false };

  beforeEach(() => {
    vi.mocked(validateRequestBody).mockResolvedValue(updatePayload as never);
  });

  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for an invalid CUID', async () => {
    // Act
    const response = await PATCH(
      makePatchRequest(updatePayload, 'not-a-cuid'),
      makeParams('not-a-cuid')
    );

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiWebhookSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(404);
    expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(429);
    expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
  });

  it('updates and returns the updated webhook on success', async () => {
    // Arrange
    const existing = makeWebhook({ isActive: true });
    const updated = makeWebhook({ isActive: false, updatedAt: new Date('2025-06-01') });
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(WEBHOOK_ID);
  });

  it('calls prisma.update with the validated body and correct where clause', async () => {
    // Arrange
    const existing = makeWebhook();
    const updated = makeWebhook({ isActive: false });
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);

    // Act
    await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    // Assert: update called with validated payload data and id
    expect(prisma.aiWebhookSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WEBHOOK_ID },
        data: updatePayload,
      })
    );
  });

  it('calls logAdminAction with webhook_subscription.update and correct entity details', async () => {
    // Arrange
    const existing = makeWebhook();
    const updated = makeWebhook({ isActive: false });
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);

    // Act
    await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    // Assert: audit action logged with correct action type and entity info
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_subscription.update',
        entityType: 'webhook_subscription',
        entityId: WEBHOOK_ID,
        userId: ADMIN_ID,
      })
    );
  });
});

describe('DELETE /webhooks/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for an invalid CUID', async () => {
    // Act
    const response = await DELETE(makeDeleteRequest('not-a-cuid'), makeParams('not-a-cuid'));

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiWebhookSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(404);
    expect(prisma.aiWebhookSubscription.delete).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

    // Assert
    expect(response.status).toBe(429);
    expect(prisma.aiWebhookSubscription.delete).not.toHaveBeenCalled();
  });

  it('deletes the webhook and returns { deleted: true }', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.mocked(prisma.aiWebhookSubscription.delete).mockResolvedValue(makeWebhook() as never);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));
    const body = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('calls prisma.delete with the correct where clause', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.mocked(prisma.aiWebhookSubscription.delete).mockResolvedValue(makeWebhook() as never);

    // Act
    await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

    // Assert: delete called with the correct id
    expect(prisma.aiWebhookSubscription.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WEBHOOK_ID } })
    );
  });

  it('calls logAdminAction with webhook_subscription.delete and correct entity details', async () => {
    // Arrange
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.mocked(prisma.aiWebhookSubscription.delete).mockResolvedValue(makeWebhook() as never);

    // Act
    await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

    // Assert: audit action logged with correct action type and entity info
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_subscription.delete',
        entityType: 'webhook_subscription',
        entityId: WEBHOOK_ID,
        userId: ADMIN_ID,
      })
    );
  });
});
