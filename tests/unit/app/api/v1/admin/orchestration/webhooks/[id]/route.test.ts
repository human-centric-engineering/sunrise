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
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { validateRequestBody } from '@/lib/api/validation';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/webhooks/[id]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    channel: 'webhook',
    url: 'https://example.com/webhook',
    emailAddress: null,
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
    vi.mocked(validateRequestBody).mockResolvedValue(updatePayload);
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

  it('excludes the always-bumping updatedAt/createdAt from the audit diff (#396)', async () => {
    // `updatedAt` bumps on every Prisma `update()`, so the route must filter it
    // (and createdAt) out of the audit diff — otherwise every PATCH records a
    // spurious timestamp change. computeChanges' ignoreKeys behaviour is
    // unit-tested for real in admin-audit-logger.test.ts.
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(
      makeWebhook({ isActive: false }) as never
    );

    await PATCH(makePatchRequest(updatePayload), makeParams(WEBHOOK_ID));

    expect(vi.mocked(computeChanges).mock.calls.at(-1)?.[2]).toEqual({
      ignoreKeys: ['updatedAt', 'createdAt'],
    });
  });

  // ── Channel-coherence validation ────────────────────────────────────────
  //
  // PATCH allows partial updates including channel flips. The route must
  // refuse a patch that would leave the row without the destination field
  // its (next) channel requires.

  describe('channel coherence', () => {
    it('rejects webhook→email flip when emailAddress is absent on both patch and row', async () => {
      const existing = makeWebhook({ channel: 'webhook', emailAddress: null });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(validateRequestBody).mockResolvedValue({ channel: 'email' });

      const response = await PATCH(makePatchRequest({ channel: 'email' }), makeParams(WEBHOOK_ID));
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string; details: Record<string, string[]> };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Email channel requires an emailAddress');
      expect(body.error.details.emailAddress).toContain('emailAddress is required');
      expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
    });

    it('rejects email→webhook flip when url is absent on both patch and row', async () => {
      const existing = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(validateRequestBody).mockResolvedValue({
        channel: 'webhook',
        secret: 'new-secret-123456',
      });

      const response = await PATCH(
        makePatchRequest({ channel: 'webhook', secret: 'new-secret-123456' }),
        makeParams(WEBHOOK_ID)
      );
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string; details: Record<string, string[]> };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Webhook channel requires a url');
      expect(body.error.details.url).toContain('url is required');
      expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
    });

    it('rejects email→webhook flip when patch omits the secret entirely', async () => {
      // Flipping to webhook channel from email requires a fresh signing
      // secret — the email row never had one to "keep".
      const existing = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(validateRequestBody).mockResolvedValue({
        channel: 'webhook',
        url: 'https://example.com/hook',
      });

      const response = await PATCH(
        makePatchRequest({ channel: 'webhook', url: 'https://example.com/hook' }),
        makeParams(WEBHOOK_ID)
      );
      const body = await parseJson<{
        error: { message: string; details: Record<string, string[]> };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Switching to webhook channel requires a secret');
      expect(body.error.details.secret).toContain(
        'secret is required when changing channel to webhook'
      );
      expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
    });

    it('accepts webhook→email flip when the patch supplies emailAddress', async () => {
      const existing = makeWebhook({ channel: 'webhook' });
      const updated = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({
        channel: 'email',
        emailAddress: 'alerts@example.com',
      });

      const response = await PATCH(
        makePatchRequest({ channel: 'email', emailAddress: 'alerts@example.com' }),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiWebhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel: 'email',
            emailAddress: 'alerts@example.com',
          }),
        })
      );
    });

    it('accepts email→webhook flip when patch supplies both url and secret', async () => {
      const existing = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      const updated = makeWebhook({ channel: 'webhook' });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({
        channel: 'webhook',
        url: 'https://example.com/hook',
        secret: 'new-secret-123456',
      });

      const response = await PATCH(
        makePatchRequest({
          channel: 'webhook',
          url: 'https://example.com/hook',
          secret: 'new-secret-123456',
        }),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiWebhookSubscription.update).toHaveBeenCalled();
    });

    it('accepts a same-channel PATCH that does NOT flip the channel (no secret required)', async () => {
      // Updating only isActive on an existing webhook-channel row should
      // not trip the email→webhook secret requirement.
      const existing = makeWebhook({ channel: 'webhook' });
      const updated = makeWebhook({ channel: 'webhook', isActive: false });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({ isActive: false });

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(200);
      expect(prisma.aiWebhookSubscription.update).toHaveBeenCalled();
    });

    it('accepts a webhook-channel PATCH that updates url alone (existing secret kept)', async () => {
      // Same-channel update of url should not require secret in the patch.
      const existing = makeWebhook({ channel: 'webhook' });
      const updated = makeWebhook({ channel: 'webhook', url: 'https://new.example.com/hook' });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({
        url: 'https://new.example.com/hook',
      });

      const response = await PATCH(
        makePatchRequest({ url: 'https://new.example.com/hook' }),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(200);
    });

    it('rejects clearing url on a webhook-channel row (patch sets url:null)', async () => {
      const existing = makeWebhook({ channel: 'webhook' });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      // The 'url' key IS present on the patch, but its value is null —
      // coherence check uses `'url' in body`, so this branch fires.
      vi.mocked(validateRequestBody).mockResolvedValue({ url: null });

      const response = await PATCH(makePatchRequest({ url: null }), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ error: { message: string } }>(response);

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Webhook channel requires a url');
      expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
    });

    it('rejects clearing emailAddress on an email-channel row (patch sets emailAddress:null)', async () => {
      const existing = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(validateRequestBody).mockResolvedValue({ emailAddress: null });

      const response = await PATCH(
        makePatchRequest({ emailAddress: null }),
        makeParams(WEBHOOK_ID)
      );
      const body = await parseJson<{ error: { message: string } }>(response);

      expect(response.status).toBe(400);
      expect(body.error.message).toBe('Email channel requires an emailAddress');
      expect(prisma.aiWebhookSubscription.update).not.toHaveBeenCalled();
    });
  });

  // ── Audit entityName uses channel-appropriate destination ───────────────

  describe('audit entityName', () => {
    it('uses url as entityName for webhook channel', async () => {
      const existing = makeWebhook({ channel: 'webhook' });
      const updated = makeWebhook({ channel: 'webhook', url: 'https://example.com/webhook' });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({ isActive: false });

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityName: 'https://example.com/webhook' })
      );
    });

    it('uses emailAddress as entityName for email channel', async () => {
      const existing = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
      });
      const updated = makeWebhook({
        channel: 'email',
        url: null,
        emailAddress: 'alerts@example.com',
        isActive: false,
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(existing as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(updated as never);
      vi.mocked(validateRequestBody).mockResolvedValue({ isActive: false });

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityName: 'alerts@example.com' })
      );
    });
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
