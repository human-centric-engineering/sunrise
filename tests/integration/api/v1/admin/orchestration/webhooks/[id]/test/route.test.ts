/**
 * Integration Test: Admin Orchestration — Webhook Test Ping
 *
 * POST /api/v1/admin/orchestration/webhooks/:id/test
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Scoped to calling user's own webhooks (createdBy filter)
 * - Bad CUID returns 400
 * - Missing signing secret returns 200 with a descriptive error payload
 * - Happy path: HMAC-SHA256 signature wired over correct canonical payload
 * - Outbound 500 and AbortError are returned in the response envelope, not thrown
 * - Route performs zero DB writes (read-only side-effect contract)
 *
 * @see app/api/v1/admin/orchestration/webhooks/[id]/test/route.ts
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/webhooks/[id]/test/route';
import {
  createMockAuthSession,
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

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
      // Explicitly absent: create/update/delete — asserting they are never called
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      },
      { status: 429 }
    )
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu1';
const OTHER_ADMIN_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';
const WEBHOOK_SECRET = 'test-signing-secret-abc123';
const WEBHOOK_URL = 'https://example.com/webhook-receiver';

function makeWebhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    url: WEBHOOK_URL,
    events: ['agent.execution.completed'],
    secret: WEBHOOK_SECRET,
    isActive: true,
    description: 'Test webhook',
    createdBy: 'cmjbv4i3x00003wsloputgwul', // matches mockAdminUser id
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/webhooks/${WEBHOOK_ID}/test`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/webhooks/:id/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Authentication & Authorization ────────────────────────────────────────

  describe('Authentication & Authorization', () => {
    it('returns 401 with UNAUTHORIZED envelope when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
        response
      );

      // Assert — status first, then full envelope
      expect(response.status).toBe(401);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: expect.any(String),
        },
      });
    });

    it('returns 403 with FORBIDDEN envelope when authenticated as non-admin USER', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
        response
      );

      // Assert — status first, then full envelope
      expect(response.status).toBe(403);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: expect.any(String),
        },
      });
    });
  });

  // ─── Rate Limiting ─────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 when adminLimiter is exhausted before DB is consulted', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
        response
      );

      // Assert — rate limit fires before any DB call; envelope matches the
      // shape `createRateLimitResponse` produces in `lib/security/rate-limit.ts`.
      expect(response.status).toBe(429);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      });
      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).not.toHaveBeenCalled();
    });
  });

  // ─── Validation ───────────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('returns 400 with VALIDATION_ERROR envelope when id is not a valid CUID', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      const response = await POST(makeRequest(), makeParams(INVALID_ID));
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string; details: Record<string, string[]> };
      }>(response);

      // Assert — status first, then full envelope with details
      expect(response.status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid webhook id',
          details: { id: ['Must be a valid CUID'] },
        },
      });
      // DB must not be touched
      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).not.toHaveBeenCalled();
    });
  });

  // ─── Ownership Scoping ────────────────────────────────────────────────────

  describe('Ownership scoping', () => {
    it('returns 404 with NOT_FOUND envelope when webhook belongs to another user', async () => {
      // Arrange: the DB returns null because the createdBy filter excludes other-user records
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ success: boolean; error: { code: string; message: string } }>(
        response
      );

      // Assert
      expect(response.status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: expect.any(String),
        },
      });

      // Assert the DB was queried with the createdBy ownership filter
      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: WEBHOOK_ID,
            createdBy: 'cmjbv4i3x00003wsloputgwul', // session.user.id from mockAdminUser
          }),
        })
      );
      // Fetch must not fire when webhook is not found
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('uses a different admin id to confirm cross-user isolation', async () => {
      // Arrange: a second admin's session — the DB still returns null (ownership excluded).
      // Build the override keeping session.userId === user.id (better-auth contract).
      const baseAdmin = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockAuthSession({
          session: { ...baseAdmin.session, userId: OTHER_ADMIN_ID },
          user: { ...baseAdmin.user, id: OTHER_ADMIN_ID, role: 'ADMIN' },
        })
      );
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));

      // Assert — the where clause used the second admin's id
      expect(response.status).toBe(404);
      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdBy: OTHER_ADMIN_ID,
          }),
        })
      );
    });
  });

  // ─── No Signing Secret ────────────────────────────────────────────────────

  describe('Webhook has no signing secret', () => {
    it('returns 200 with advisory error payload and does not call fetch', async () => {
      // Arrange: webhook has no secret configured
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow({ secret: null }) as never
      );

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      // Assert — status first, then outer envelope, then inner delivery result
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on outer API response field
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        success: false,
        statusCode: null,
        durationMs: 0,
        error: 'Webhook has no signing secret. Set a secret before testing.',
      });

      // No outbound HTTP should be made
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ─── Happy Path — HMAC contract ───────────────────────────────────────────

  describe('Happy path', () => {
    it('sends a POST with a valid HMAC-SHA256 signature and returns success delivery result', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );

      // Capture the outbound request via a spy that returns 200
      let capturedRequest: RequestInit | undefined;
      let capturedUrl: string | undefined;
      vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
        capturedUrl = url as string;
        capturedRequest = init;
        return new Response(null, { status: 200 });
      });

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: number; durationMs: number; error: null };
      }>(response);

      // Assert outer envelope
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on outer API response field
      expect(body.success).toBe(true);

      // Assert delivery result
      expect(body.data.success).toBe(true);
      expect(body.data.statusCode).toBe(200);
      expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.data.error).toBeNull();

      // Assert the outbound fetch was called with the correct URL
      expect(capturedUrl).toBe(WEBHOOK_URL);
      expect(capturedRequest?.method).toBe('POST');

      // Assert headers — Content-Type and X-Webhook-Event are set
      const headers = capturedRequest?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Webhook-Event']).toBe('ping');

      // HMAC contract: recompute the signature over the exact body sent on the wire
      // and verify it matches what the route computed. This pins the wire format and
      // prevents regressions where payload shape silently drifts away from what receivers verify.
      const sentBody = capturedRequest?.body as string;
      const parsedBody = JSON.parse(sentBody) as {
        event: string;
        timestamp: string;
        data: { message: string };
      };

      // Verify payload structure
      expect(parsedBody.event).toBe('ping');
      expect(typeof parsedBody.timestamp).toBe('string');
      expect(parsedBody.data).toEqual({
        message: 'Test event from Sunrise webhook configuration.',
      });

      // Recompute HMAC over the exact serialised payload that was sent
      const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(sentBody)
        .digest('hex');

      expect(headers['X-Webhook-Signature']).toBe(expectedSignature);
    });
  });

  // ─── Outbound failure scenarios ───────────────────────────────────────────

  describe('Outbound HTTP failures', () => {
    it('returns 200 with success:false and statusCode:500 when receiver returns 500', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }) as never);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: number; durationMs: number; error: null };
      }>(response);

      // Assert — the route itself succeeds (200); the delivery failed
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on outer API response field
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBe(500);
      expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns 200 with timed-out error string when fetch throws AbortError', async () => {
      // Arrange: directly trigger an AbortError-shaped rejection (no fake timers needed)
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );

      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      // Assert — the route returns 200 (outer), delivery failed with timeout message
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on outer API response field
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.error).toBe('Request timed out after 5 seconds');
    });
  });

  // ─── Zero DB side-effects ─────────────────────────────────────────────────

  describe('Zero DB side-effects', () => {
    it('does not write to the DB on a successful test ping (read-only route)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhookRow() as never
      );
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }) as never);

      // Act
      const response = await POST(makeRequest(), makeParams(WEBHOOK_ID));
      const body = await parseJson<{ success: boolean; data: { success: boolean } }>(response);

      // Assert: outer response is 200 success — confirms we're testing the success path
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(true);

      // Assert: the only DB method that should have been called is findFirst (a read).
      // The mock object has no create/update/delete — verifying findFirst was called once
      // and no writes occurred. If the route tried to write, it would have thrown because
      // those methods are absent from the mock.
      expect(vi.mocked(prisma.aiWebhookSubscription.findFirst)).toHaveBeenCalledTimes(1);
    });
  });
});
