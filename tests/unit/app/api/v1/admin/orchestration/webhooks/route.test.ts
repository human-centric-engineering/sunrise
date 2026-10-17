/**
 * Unit Tests: Webhook Subscription List + Create Endpoints
 *
 * GET  /api/v1/admin/orchestration/webhooks
 * POST /api/v1/admin/orchestration/webhooks
 *
 * Test Coverage:
 * - GET: happy path (paginated list), isActive filter, pagination params
 * - GET: authentication
 * - POST: create valid webhook subscription
 * - POST: validation errors (missing URL, bad URL, short secret, invalid event)
 * - POST: rate limiting, authentication
 *
 * @see app/api/v1/admin/orchestration/webhooks/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
    // The erased-person check runs in the write's transaction (t-805)
    $executeRaw: vi.fn(),
    dataErasureReceipt: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  return { prisma };
});

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// The webhook URL validator calls checkSafeProviderUrl; mock it so we don't
// need real network access and can control allow/deny behaviour.
vi.mock('@/lib/security/safe-url', () => ({
  checkSafeProviderUrl: vi.fn((url: string) => !url.includes('internal')),
  isSafeProviderUrl: vi.fn((url: string) => !url.includes('internal')),
}));

const mockLogInfo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: mockLogInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { GET, POST } from '@/app/api/v1/admin/orchestration/webhooks/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

const mockWebhook = {
  id: 'wh-001',
  url: 'https://example.com/webhook',
  events: ['execution_completed'],
  isActive: true,
  description: 'Test webhook',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(queryString = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/webhooks${queryString}`,
  } as unknown as NextRequest;
}

function makePostRequest(body: unknown): NextRequest {
  return new Request('http://localhost:3000/api/v1/admin/orchestration/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook Subscription API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    vi.mocked(prisma.dataErasureReceipt.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  /** A fork that lets admins manage their own subscriptions and nobody's orphans. */
  function refuseUnattributedReads(): void {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed'
          ? Promise.resolve(false)
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });
  }

  // ── GET — List webhooks ─────────────────────────────────────────────────

  describe('GET /webhooks', () => {
    it('returns paginated webhook subscriptions', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([mockWebhook] as never);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(1);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('wh-001');
      expect(json.meta.total).toBe(1);
    });

    it('returns empty list when no webhooks exist', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      expect(json.data).toHaveLength(0);
      expect(json.meta.total).toBe(0);
    });

    it('filters by isActive=true', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?isActive=true'));

      // Assert: visibility clause AND isActive, composed with AND so the
      // filter cannot replace the visibility fragment's OR key
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }, { isActive: true }],
          },
        })
      );
    });

    it('filters by isActive=false', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?isActive=false'));

      // Assert
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }, { isActive: false }],
          },
        })
      );
    });

    it('scopes results to the current user plus orphaned subscriptions when the policy permits', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest());

      // Assert: the same where on the page query and the count query
      const expected = { AND: [{ OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] }] };
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expected })
      );
      expect(prisma.aiWebhookSubscription.count).toHaveBeenCalledWith({ where: expected });
    });

    it('drops the orphan arm from both queries when the policy refuses unattributed reads', async () => {
      // Arrange
      refuseUnattributedReads();
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest('?isActive=true'));

      // Assert
      const expected = { AND: [{ createdBy: ADMIN_ID }, { isActive: true }] };
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expected })
      );
      expect(prisma.aiWebhookSubscription.count).toHaveBeenCalledWith({ where: expected });
    });

    it('passes createdBy through, null for a subscription whose creator was erased', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
        { ...mockWebhook, createdBy: ADMIN_ID },
        { ...mockWebhook, id: 'wh-orphan', createdBy: null },
      ] as never);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(2);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert: the select asks for the column, and the response carries it
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ createdBy: true }) })
      );
      expect(json.data[0].createdBy).toBe(ADMIN_ID);
      expect(json.data[1]).toHaveProperty('createdBy', null);
    });

    it('applies pagination skip and take', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act: page=2, limit=5 → skip=5
      await GET(makeGetRequest('?page=2&limit=5'));

      // Assert
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });

    it('returns 401 for unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await GET(makeGetRequest());

      // Assert
      expect(res.status).toBe(401);
    });
  });

  // ── POST — Create webhook ───────────────────────────────────────────────

  describe('POST /webhooks', () => {
    const validPayload = {
      url: 'https://example.com/hook',
      secret: 'super-secret-value-here-32chars',
      events: ['execution_completed'],
      description: 'My webhook',
    };

    it('creates a webhook subscription', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue(mockWebhook as never);

      // Act
      const res = await POST(makePostRequest(validPayload));
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(201);
      expect(json.data.id).toBe('wh-001');
      expect(prisma.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: validPayload.url,
            createdBy: ADMIN_ID,
          }),
        })
      );
    });

    it('does not log a credential carried in the subscription URL (#953)', async () => {
      const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWx';
      const url = `https://example.com/services/T0000/B0000/${SECRET}?token=qs-secret`;
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        ...mockWebhook,
        channel: 'webhook',
        url,
      } as never);

      const res = await POST(makePostRequest({ ...validPayload, url }));

      expect(res.status).toBe(201);
      expect(mockLogInfo).toHaveBeenCalledWith(
        'Webhook created',
        expect.objectContaining({ destination: 'https://example.com/services/T0000/B0000/[param]' })
      );
      const logged = JSON.stringify(mockLogInfo.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('qs-secret');
    });

    it('records only the URL origin in the audit entry (t-777, t-785)', async () => {
      const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWx';
      const url = `https://hooks.slack.com/services/T0000/B0000/${SECRET}?token=qs-secret`;
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        ...mockWebhook,
        channel: 'webhook',
        url,
      } as never);

      const res = await POST(makePostRequest({ ...validPayload, url }));

      expect(res.status).toBe(201);
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'wh-001',
          entityName: 'https://hooks.slack.com',
        })
      );
      const audited = JSON.stringify(vi.mocked(logAdminAction).mock.calls);
      expect(audited).not.toContain(SECRET);
      expect(audited).not.toContain('qs-secret');
    });

    it('writes no email address into the audit entry or the log line (t-785)', async () => {
      const ADDRESS = 'alerts@example.com';
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        ...mockWebhook,
        channel: 'email',
        url: null,
        emailAddress: ADDRESS,
      } as never);

      const res = await POST(
        makePostRequest({
          channel: 'email',
          emailAddress: ADDRESS,
          events: ['execution_completed'],
        })
      );

      expect(res.status).toBe(201);
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'wh-001', entityName: 'wh-001' })
      );
      expect(JSON.stringify(vi.mocked(logAdminAction).mock.calls)).not.toContain(ADDRESS);
      expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(ADDRESS);
    });

    it('defaults isActive to true when not specified', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue(mockWebhook as never);

      // Act
      await POST(makePostRequest({ ...validPayload }));

      // Assert: isActive defaults to true
      expect(prisma.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: true }),
        })
      );
    });

    it('persists per-subscription retry policy when sent', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue(mockWebhook as never);

      // Act
      await POST(
        makePostRequest({
          ...validPayload,
          maxAttempts: 5,
          retryBackoffMs: [10_000, 30_000, 60_000, 300_000],
        })
      );

      // Assert: both fields reach the create call so the dispatcher reads
      // them on every delivery.
      expect(prisma.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            maxAttempts: 5,
            retryBackoffMs: [10_000, 30_000, 60_000, 300_000],
          }),
        })
      );
    });

    it('rejects retry policy with too few backoff entries for maxAttempts', async () => {
      // maxAttempts=5 needs at least 4 backoff entries.
      const res = await POST(
        makePostRequest({
          ...validPayload,
          maxAttempts: 5,
          retryBackoffMs: [10_000, 30_000],
        })
      );

      expect(res.status).toBe(400);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects retry policy with backoff entries above the 24h cap', async () => {
      const res = await POST(
        makePostRequest({
          ...validPayload,
          maxAttempts: 2,
          retryBackoffMs: [25 * 60 * 60 * 1000], // 25h
        })
      );

      expect(res.status).toBe(400);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });

    it('creates an email-channel subscription with emailAddress', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        ...mockWebhook,
        channel: 'email',
        url: null,
        secret: null,
        emailAddress: 'alerts@example.com',
      } as never);

      // Act — no url/secret, just channel + emailAddress
      const res = await POST(
        makePostRequest({
          channel: 'email',
          emailAddress: 'alerts@example.com',
          events: ['workflow_failed'],
        })
      );

      // Assert
      expect(res.status).toBe(201);
      expect(prisma.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel: 'email',
            emailAddress: 'alerts@example.com',
          }),
        })
      );
    });

    it('refuses an email subscription for an erased address with a 400 and writes nothing (t-805)', async () => {
      // A receipt exists for the (verified) address the form still holds
      vi.mocked(prisma.dataErasureReceipt.findMany).mockResolvedValue([
        {
          subjectUserId: 'gone-user',
          subjectEmailHash: createHash('sha256').update('gone@example.com').digest('hex'),
          metadata: { addressVerified: true },
        },
      ] as never);

      const res = await POST(
        makePostRequest({
          channel: 'email',
          emailAddress: 'Gone@Example.com',
          events: ['workflow_failed'],
        })
      );
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.details.emailAddress).toEqual([expect.stringMatching(/erased/i)]);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('does not consult erasure receipts for a URL-channel subscription (t-805)', async () => {
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue(mockWebhook as never);

      const res = await POST(makePostRequest(validPayload));

      expect(res.status).toBe(201);
      expect(prisma.dataErasureReceipt.findMany).not.toHaveBeenCalled();
    });

    it('rejects an email-channel subscription with no emailAddress', async () => {
      const res = await POST(
        makePostRequest({
          channel: 'email',
          events: ['workflow_failed'],
        })
      );
      expect(res.status).toBe(400);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects an email-channel subscription with a malformed email', async () => {
      const res = await POST(
        makePostRequest({
          channel: 'email',
          emailAddress: 'not-an-email',
          events: ['workflow_failed'],
        })
      );
      expect(res.status).toBe(400);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });

    it('respects isActive=false when explicitly set', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.create).mockResolvedValue({
        ...mockWebhook,
        isActive: false,
      } as never);

      // Act
      await POST(makePostRequest({ ...validPayload, isActive: false }));

      // Assert
      expect(prisma.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: false }),
        })
      );
    });

    it('returns 400 when URL is missing', async () => {
      // Arrange: no url field
      const { url: _url, ...withoutUrl } = validPayload;

      // Act
      const res = await POST(makePostRequest(withoutUrl));

      // Assert
      expect(res.status).toBe(400);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });

    it('returns 400 when secret is too short (< 16 chars)', async () => {
      // Act
      const res = await POST(makePostRequest({ ...validPayload, secret: 'short' }));

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 when events array is empty', async () => {
      // Act
      const res = await POST(makePostRequest({ ...validPayload, events: [] }));

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 400 for an invalid event type', async () => {
      // Act
      const res = await POST(makePostRequest({ ...validPayload, events: ['not_a_real_event'] }));

      // Assert
      expect(res.status).toBe(400);
    });

    it('returns 401 for unauthenticated requests', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const res = await POST(makePostRequest(validPayload));

      // Assert
      expect(res.status).toBe(401);
    });
  });
});
