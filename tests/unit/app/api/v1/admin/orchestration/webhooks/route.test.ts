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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

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
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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

// The webhook URL validator calls checkSafeProviderUrl; mock it so we don't
// need real network access and can control allow/deny behaviour.
vi.mock('@/lib/security/safe-url', () => ({
  checkSafeProviderUrl: vi.fn((url: string) => !url.includes('internal')),
  isSafeProviderUrl: vi.fn((url: string) => !url.includes('internal')),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/admin/orchestration/webhooks/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
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
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

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

      // Assert: where clause scoped to current user AND isActive
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdBy: ADMIN_ID,
            isActive: true,
          }),
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
          where: expect.objectContaining({ isActive: false }),
        })
      );
    });

    it('scopes results to the current user', async () => {
      // Arrange
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiWebhookSubscription.count).mockResolvedValue(0);

      // Act
      await GET(makeGetRequest());

      // Assert: always filtered by createdBy === current user id
      expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdBy: ADMIN_ID }),
        })
      );
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

    it('returns 429 when rate limited', async () => {
      // Arrange
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      // Act
      const res = await POST(makePostRequest(validPayload));

      // Assert
      expect(res.status).toBe(429);
      expect(prisma.aiWebhookSubscription.create).not.toHaveBeenCalled();
    });
  });
});
