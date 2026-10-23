/**
 * Integration Test: Webhook subscription CRUD
 *
 * GET  /api/v1/admin/orchestration/webhooks
 * POST /api/v1/admin/orchestration/webhooks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/webhooks/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => {
  const prisma = {
    aiWebhookSubscription: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    // Watched so a test can show a create asks erasure nothing (t-899)
    dataErasureReceipt: { findMany: vi.fn(async () => []) },
  };
  return { prisma };
});

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeGetRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/webhooks');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  url: 'https://example.com/webhook',
  secret: 'a-valid-secret-key-16chars',
  events: ['budget_exceeded', 'workflow_failed'],
  description: 'Test webhook',
};

import {
  SUBSCRIPTION_VERSION_SELECT,
  subscriptionVersion,
} from '@/lib/orchestration/config-versions';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Webhook CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /webhooks', () => {
    it('returns 401 for unauthenticated user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const res = await GET(makeGetRequest());
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const res = await GET(makeGetRequest());
      expect(res.status).toBe(403);
    });

    it('lists webhooks scoped to current user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      (prisma.aiWebhookSubscription.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.aiWebhookSubscription.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const res = await GET(makeGetRequest());
      expect(res.status).toBe(200);

      const call = (prisma.aiWebhookSubscription.findMany as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      // The caller's own subscriptions, plus ones whose creator was erased
      // (the default policy lets an admin manage those); never another admin's.
      expect(call.where).toEqual({
        AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }],
      });
    });

    it("returns each row's version, as the row's own PATCH computes it (t-899)", async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const row = {
        id: 'sub-1',
        channel: 'email',
        url: null,
        emailAddress: 'ops@example.com',
        events: ['workflow_failed'],
        agentIds: [],
        workflowIds: [],
        isActive: true,
        description: null,
        maxAttempts: 3,
        retryBackoffMs: [10000],
      };
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([row] as never);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(1);

      const res = await GET(makeGetRequest());

      const body = (await res.json()) as { data: Array<{ version: string }> };
      expect(body.data[0].version).toBe(subscriptionVersion(row));
      const select = vi.mocked(prisma.aiWebhookSubscription.findMany).mock.calls[0][0]?.select;
      for (const field of Object.keys(SUBSCRIPTION_VERSION_SELECT)) {
        expect(select).toHaveProperty(field, true);
      }
    });
  });

  describe('POST /webhooks', () => {
    it('returns 401 for unauthenticated user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const res = await POST(makePostRequest(VALID_BODY));
      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const res = await POST(makePostRequest({ ...VALID_BODY, url: 'not-a-url' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for secret shorter than 16 chars', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const res = await POST(makePostRequest({ ...VALID_BODY, secret: 'short' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty events array', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const res = await POST(makePostRequest({ ...VALID_BODY, events: [] }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid event type', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const res = await POST(makePostRequest({ ...VALID_BODY, events: ['invalid_event'] }));
      expect(res.status).toBe(400);
    });

    it('creates webhook with valid body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const created = {
        id: 'webhook-1',
        url: VALID_BODY.url,
        events: VALID_BODY.events,
        isActive: true,
        description: VALID_BODY.description,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (prisma.aiWebhookSubscription.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const res = await POST(makePostRequest(VALID_BODY));
      expect(res.status).toBe(201);

      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toMatchObject({
        id: 'webhook-1',
        url: VALID_BODY.url,
        events: VALID_BODY.events,
      });

      // Verify secret is not in the select output (not returned)
      expect(body.data).not.toHaveProperty('secret');
    });

    it('sets createdBy to current user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      (prisma.aiWebhookSubscription.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await POST(makePostRequest(VALID_BODY));

      const call = (prisma.aiWebhookSubscription.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.data.createdBy).toBe(ADMIN_ID);
    });

    it('creates an email subscription for an address typed in, without asking who was erased (t-899)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        id: 'sub-1',
        channel: 'email',
        url: null,
        emailAddress: 'readded@example.com',
        events: ['workflow_failed'],
        agentIds: [],
        workflowIds: [],
        isActive: true,
        description: null,
        maxAttempts: 3,
        retryBackoffMs: [10000, 60000, 300000],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);

      const res = await POST(
        makePostRequest({
          channel: 'email',
          emailAddress: 'readded@example.com',
          events: ['workflow_failed'],
        })
      );

      expect(res.status).toBe(201);
      expect(prisma.dataErasureReceipt.findMany).not.toHaveBeenCalled();
      const body = (await res.json()) as { data: { version: string } };
      expect(body.data.version).toMatch(/^"[\w-]{27}"$/);
    });
  });
});
