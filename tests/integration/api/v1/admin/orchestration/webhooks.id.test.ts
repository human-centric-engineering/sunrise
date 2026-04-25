/**
 * Integration Test: Admin Orchestration — Webhook Subscription Detail
 *
 * GET    /api/v1/admin/orchestration/webhooks/:id — get subscription
 * PATCH  /api/v1/admin/orchestration/webhooks/:id — update subscription
 * DELETE /api/v1/admin/orchestration/webhooks/:id — delete subscription
 *
 * @see app/api/v1/admin/orchestration/webhooks/[id]/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited on PATCH and DELETE (adminLimiter)
 * - Scoped to calling user's own subscriptions (createdBy)
 * - Bad CUID returns 400
 * - Missing or foreign webhook returns 404
 * - CRITICAL: 500 responses do NOT leak raw error messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/webhooks/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

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

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/webhooks/${WEBHOOK_ID}`;

function makeWebhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    url: 'https://example.com/webhook',
    events: ['agent.execution.completed'],
    isActive: true,
    description: 'Test webhook',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

const VALID_PATCH_BODY = {
  url: 'https://example.com/updated-webhook',
  isActive: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: BASE_URL,
  } as unknown as NextRequest;
}

function makePatchRequest(body: Record<string, unknown> = VALID_PATCH_BODY): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'PATCH',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: BASE_URL,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: BASE_URL,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests — GET ─────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/webhooks/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns 200 with the webhook', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string; url: string } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(WEBHOOK_ID);
      expect(data.data.url).toBe('https://example.com/webhook');
    });

    it('does not return the secret field', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));
      const data = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

      expect(data.data).not.toHaveProperty('secret');
    });
  });

  describe('Error cases', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when webhook does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when webhook belongs to a different user (scoping enforced)', async () => {
      // findFirst with { where: { id, createdBy: userId } } returns null for foreign webhooks
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(404);
    });
  });
});

// ─── Tests — PATCH ───────────────────────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/webhooks/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful update', () => {
    it('returns 200 with the updated webhook', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(
        makeWebhookRow({ url: VALID_PATCH_BODY.url, isActive: false }) as never
      );

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string; isActive: boolean } }>(
        response
      );
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(WEBHOOK_ID);
      expect(data.data.isActive).toBe(false);
    });

    it('calls update with the parsed id and body fields', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(makeWebhookRow() as never);

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(vi.mocked(prisma.aiWebhookSubscription.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WEBHOOK_ID },
          data: expect.objectContaining({ isActive: false }),
        })
      );
    });
  });

  describe('Error cases', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await PATCH(makePatchRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when webhook does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message', async () => {
      const INTERNAL_MSG = 'db-update-exploded';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await PATCH(makePatchRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(INTERNAL_MSG);
    });
  });
});

// ─── Tests — DELETE ───────────────────────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/webhooks/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(429);
    });
  });

  describe('Successful deletion', () => {
    it('returns 200 with { deleted: true }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.delete).mockResolvedValue(makeWebhookRow() as never);

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.deleted).toBe(true);
    });

    it('calls delete with the correct webhook id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.delete).mockResolvedValue(makeWebhookRow() as never);

      await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(vi.mocked(prisma.aiWebhookSubscription.delete)).toHaveBeenCalledWith({
        where: { id: WEBHOOK_ID },
      });
    });
  });

  describe('Error cases', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await DELETE(makeDeleteRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when webhook does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message', async () => {
      const INTERNAL_MSG = 'db-delete-exploded';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.delete).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await DELETE(makeDeleteRequest(), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(INTERNAL_MSG);
    });
  });
});
