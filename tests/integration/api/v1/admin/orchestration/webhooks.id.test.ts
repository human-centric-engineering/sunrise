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
 * - Rate limiting enforced by proxy.ts (orchestration tier)
 * - Scoped to calling user's own subscriptions (createdBy)
 * - Bad CUID returns 400
 * - Missing or foreign webhook returns 404
 * - CRITICAL: 500 responses do NOT leak raw error messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/webhooks/[id]/route';
import { subscriptionVersion } from '@/lib/orchestration/config-versions';
import { computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
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

vi.mock('@/lib/db/client', () => {
  const prisma = {
    aiWebhookSubscription: {
      findFirst: vi.fn(),
      // The row as the versioned save reads it under its lock (t-899)
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    // The row lock a versioned save takes (t-899)
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  return { prisma };
});

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu1';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul'; // mockAdminUser's id
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

/** The stored row's version, as the GET returned it to the form (t-899). */
const LOADED_VERSION = subscriptionVersion(makeWebhookRow() as never);

function makePatchRequest(
  body: Record<string, unknown> = VALID_PATCH_BODY,
  ifMatch: string | null = LOADED_VERSION
): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'PATCH',
    headers: new Headers({
      'Content-Type': 'application/json',
      ...(ifMatch === null ? {} : { 'If-Match': ifMatch }),
    }),
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(WEBHOOK_ID);
      expect(data.data.url).toBe('https://example.com/webhook');
    });

    it('returns the version a save sends back, in the body and not as the ETag (t-899)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );

      const response = await GET(makeGetRequest(), makeParams(WEBHOOK_ID));

      const data = await parseJson<{ data: { version: string } }>(response);
      expect(data.data.version).toBe(LOADED_VERSION);
      // It covers only what a save writes, so it is no ETag for this body.
      expect(response.headers.get('ETag')).toBeNull();
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
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    // Unchanged since the form loaded it, unless a test says otherwise
    vi.mocked(prisma.aiWebhookSubscription.findUniqueOrThrow).mockResolvedValue(
      makeWebhookRow() as never
    );
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

    it('scopes the lookup to the caller (plus creatorless rows) and the id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(makeWebhookRow() as never);

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }, { id: WEBHOOK_ID }],
          },
        })
      );
    });

    it('returns the new version with the saved row (t-899)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      const saved = makeWebhookRow({ isActive: false });
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(saved as never);

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      const data = await parseJson<{ data: { version: string } }>(response);
      expect(data.data.version).toBe(subscriptionVersion(saved as never));
      expect(data.data.version).not.toBe(LOADED_VERSION);
    });

    it('locks the row before reading the version it checks (t-899)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(makeWebhookRow() as never);

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      const lockedAt = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0];
      const readAt = vi.mocked(prisma.aiWebhookSubscription.findUniqueOrThrow).mock
        .invocationCallOrder[0];
      expect(lockedAt).toBeLessThan(readAt);
      const [sql] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [TemplateStringsArray];
      expect(sql.join('?')).toMatch(/FROM ai_webhook_subscription WHERE id = \? FOR NO KEY UPDATE/);
    });

    it('saves an address typed into a freshly loaded form, erased or not (t-899)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const row = makeWebhookRow({ channel: 'email', url: null, emailAddress: 'old@example.com' });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(row as never);
      vi.mocked(prisma.aiWebhookSubscription.findUniqueOrThrow).mockResolvedValue(row as never);
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue({
        ...row,
        emailAddress: 'readded@example.com',
      } as never);

      const response = await PATCH(
        makePatchRequest(
          { emailAddress: 'readded@example.com' },
          subscriptionVersion(row as never)
        ),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.aiWebhookSubscription.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { emailAddress: 'readded@example.com' } })
      );
    });
  });

  describe('Stale saves (t-899)', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
    });

    it.each([
      ['no If-Match', null],
      ['If-Match: *', '*'],
    ])('refuses a save with %s with 428, writing nothing', async (_label, ifMatch) => {
      const response = await PATCH(
        makePatchRequest({ isActive: false }, ifMatch),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(428);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('PRECONDITION_REQUIRED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.aiWebhookSubscription.update)).not.toHaveBeenCalled();
    });

    it('refuses a save loaded before an erasure cleared the address, with 412, writing nothing', async () => {
      // What erasure leaves (erase-user.ts): no address, switched off.
      vi.mocked(prisma.aiWebhookSubscription.findUniqueOrThrow).mockResolvedValue(
        makeWebhookRow({
          channel: 'email',
          url: null,
          emailAddress: null,
          isActive: false,
        }) as never
      );

      const response = await PATCH(makePatchRequest({ isActive: true }), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(412);
      const data = await parseJson<{ error: { code: string; message: string } }>(response);
      expect(data.error.code).toBe('STALE_RECORD');
      expect(data.error.message).toMatch(/changed since you opened it/i);
      expect(vi.mocked(prisma.aiWebhookSubscription.update)).not.toHaveBeenCalled();
      expect(vi.mocked(prisma.aiWebhookSubscription.updateMany)).not.toHaveBeenCalled();
    });

    it('refuses a save loaded before another admin changed the events, with 412', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findUniqueOrThrow).mockResolvedValue(
        makeWebhookRow({ events: ['agent.execution.failed'] }) as never
      );

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(response.status).toBe(412);
    });

    it('accepts any one of several versions in If-Match', async () => {
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(makeWebhookRow() as never);

      const response = await PATCH(
        makePatchRequest({ isActive: false }, `"other", ${LOADED_VERSION}`),
        makeParams(WEBHOOK_ID)
      );

      expect(response.status).toBe(200);
    });
  });

  describe('Audit', () => {
    it('excludes the always-bumping updatedAt/createdAt from the audit diff (#396)', async () => {
      // `updatedAt` bumps on every Prisma `update()`, so the route must filter
      // it (and createdAt) out of the audit diff — otherwise every PATCH records
      // a spurious timestamp change. computeChanges' ignoreKeys behaviour is
      // unit-tested for real in admin-audit-logger.test.ts.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.mocked(prisma.aiWebhookSubscription.update).mockResolvedValue(makeWebhookRow() as never);

      await PATCH(makePatchRequest({ isActive: false }), makeParams(WEBHOOK_ID));

      expect(vi.mocked(computeChanges).mock.calls.at(-1)?.[2]).toEqual({
        ignoreKeys: ['updatedAt', 'createdAt'],
      });
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
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
