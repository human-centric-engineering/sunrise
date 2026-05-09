/**
 * Unit Tests: POST /api/v1/admin/orchestration/webhooks/:id/test
 *
 * Sends a test ping event to a configured webhook URL and returns
 * the delivery result (status code, timing, error).
 *
 * Test Coverage:
 * - 429 rate limit blocked (before DB)
 * - 400 invalid CUID (before DB)
 * - 404 webhook not found (ownership via createdBy filter)
 * - 200 webhook with no signing secret (fetch not called)
 * - 200 happy path: HMAC signature verification via real crypto
 * - 200 fetch returns 404 (non-2xx)
 * - 200 fetch returns 500 (non-2xx)
 * - 200 AbortError timeout
 * - 200 generic Error thrown by fetch
 * - 200 non-Error thrown by fetch
 * - log.info called with correct shape after request
 *
 * @see app/api/v1/admin/orchestration/webhooks/[id]/test/route.ts
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks — must appear before imports ───────────────────────────────

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

// getRouteLogger returns a logger — capture the mock logger so tests can
// assert individual method calls.
const mockLogInfo = vi.fn();
const mockLogError = vi.fn();

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({
      info: mockLogInfo,
      error: mockLogError,
      warn: vi.fn(),
      debug: vi.fn(),
    })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser } from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/webhooks/[id]/test/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A CUID that passes cuidSchema validation */
const WEBHOOK_ID = 'cmjbv4i3x00003wsloputgwu2';
/** The admin user ID returned by mockAdminUser() */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const WEBHOOK_URL = 'https://example.com/webhook';
const WEBHOOK_SECRET = 'test-webhook-secret-key';

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    createdBy: ADMIN_ID,
    events: ['execution_completed'],
    isActive: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(id = WEBHOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/webhooks/${id}/test`, {
    method: 'POST',
  });
}

function makeParams(id = WEBHOOK_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/webhooks/:id/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated admin, rate limit passes, webhook found, fetch succeeds
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('returns 429 and does NOT query the database when rate limit is exceeded', async () => {
      // Arrange
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 30,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert: rate-limit short-circuits before DB
      expect(response.status).toBe(429);
      expect(prisma.aiWebhookSubscription.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Input validation ────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('returns 400 for an invalid CUID and does NOT query the database', async () => {
      // Act
      const response = await POST(makeRequest('not-a-cuid'), makeParams('not-a-cuid'));
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string; details: { id: string[] } };
      }>(response);

      // Assert: validation fires before any DB access
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invalid webhook id');
      expect(body.error.details.id).toContain('Must be a valid CUID');
      expect(prisma.aiWebhookSubscription.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Ownership & not-found ───────────────────────────────────────────────

  describe('Ownership filter', () => {
    it('returns 404 when the webhook is not found and calls findFirst with both id and createdBy', async () => {
      // Arrange: simulate ownership mismatch — another admin's webhook looks like not found
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(null);

      // Act
      const response = await POST(makeRequest(), makeParams());

      // Assert: 404 returned
      expect(response.status).toBe(404);

      // Assert: the ownership scope (id + createdBy) is the security guarantee
      expect(prisma.aiWebhookSubscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: WEBHOOK_ID,
            createdBy: ADMIN_ID,
          }),
        })
      );
    });
  });

  // ── No-secret path ──────────────────────────────────────────────────────

  describe('Missing signing secret', () => {
    it('returns 200 with success:false and does NOT call fetch when webhook has no secret', async () => {
      // Arrange: webhook exists but secret is null
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhook({ secret: null }) as never
      );

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      // Assert: API returns outer success:true envelope with inner delivery result
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — outer envelope shape
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.durationMs).toBe(0);
      expect(body.data.error).toBe('Webhook has no signing secret. Set a secret before testing.');
      // No outbound HTTP call should have been made
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // ── Happy path & HMAC ───────────────────────────────────────────────────

  describe('Happy path', () => {
    it('returns 200 with success:true and verifies the HMAC-SHA256 signature in X-Webhook-Signature', async () => {
      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: number; durationMs: number; error: null };
      }>(response);

      // Assert: outer envelope
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — outer envelope shape
      expect(body.success).toBe(true);
      // Assert: delivery result
      expect(body.data.success).toBe(true);
      expect(body.data.statusCode).toBe(200);
      expect(body.data.error).toBeNull();
      expect(typeof body.data.durationMs).toBe('number');

      // Assert: HMAC-SHA256 signature verification
      // Extract the actual fetch call arguments
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall).toBeDefined();

      const [url, init] = fetchCall as [string, RequestInit];
      expect(url).toBe(WEBHOOK_URL);
      expect(init.method).toBe('POST');

      // Extract the actual payload sent over the wire
      const sentPayload = init.body as string;
      expect(() => JSON.parse(sentPayload)).not.toThrow();

      const parsed = JSON.parse(sentPayload) as {
        event: string;
        timestamp: string;
        data: { message: string };
      };
      expect(parsed.event).toBe('ping');
      expect(typeof parsed.timestamp).toBe('string');
      expect(parsed.data.message).toBe('Test event from Sunrise webhook configuration.');

      // Compute expected HMAC using the real crypto module
      const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(sentPayload)
        .digest('hex');

      // The header must match the real HMAC of the payload that was sent
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Webhook-Signature']).toBe(expectedSignature);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Webhook-Event']).toBe('ping');
    });
  });

  // ── Fetch non-2xx responses ─────────────────────────────────────────────

  describe('Fetch non-2xx responses', () => {
    it('returns 200 with success:false and statusCode:404 when webhook endpoint returns 404', async () => {
      // Arrange
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: number; error: null };
      }>(response);

      // Assert: HTTP route returns 200 (not a pass-through of the remote status)
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — outer envelope shape
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBe(404);
      expect(body.data.error).toBeNull();
    });

    it('returns 200 with success:false and statusCode:500 when webhook endpoint returns 500', async () => {
      // Arrange
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        success: boolean;
        data: { success: boolean; statusCode: number; error: null };
      }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — outer envelope shape
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBe(500);
      expect(body.data.error).toBeNull();
    });
  });

  // ── Error paths ─────────────────────────────────────────────────────────

  describe('Error paths', () => {
    it('returns timeout error when fetch is aborted by the 5-second AbortController', async () => {
      // Arrange: simulate the AbortController aborting fetch
      // We use fake timers to control the 5s setTimeout in the source, but the
      // most robust approach for a unit test is to mock fetch to reject with AbortError
      // immediately (the controller.abort() path in catch).
      vi.useRealTimers();
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; error: string };
      }>(response);

      // Assert: exact timeout message as defined in source
      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.error).toBe('Request timed out after 5 seconds');
    });

    it('returns the error message when fetch throws a generic Error', async () => {
      // Arrange
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; error: string };
      }>(response);

      // Assert: the Error's message is surfaced directly
      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.error).toBe('connect ECONNREFUSED');
    });

    it('returns "Unknown error" when fetch throws a non-Error value', async () => {
      // Arrange: non-Error thrown (string, number, etc.)
      vi.spyOn(globalThis, 'fetch').mockRejectedValue('oops');

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; error: string };
      }>(response);

      // Assert: the fallback branch in the catch block
      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.error).toBe('Unknown error');
    });
  });

  // ── Logging ─────────────────────────────────────────────────────────────

  describe('Logging', () => {
    it('calls log.info with "Webhook test sent" and the correct shape after a successful ping', async () => {
      // Act
      await POST(makeRequest(), makeParams());

      // Assert: logger.info called exactly once with the expected message and fields
      expect(mockLogInfo).toHaveBeenCalledTimes(1);
      expect(mockLogInfo).toHaveBeenCalledWith(
        'Webhook test sent',
        expect.objectContaining({
          webhookId: WEBHOOK_ID,
          url: WEBHOOK_URL,
          statusCode: 200,
          // durationMs is non-deterministic wall-clock time
          durationMs: expect.any(Number),
          success: true,
        })
      );
    });

    it('calls log.info with success:false when the remote returns a 5xx', async () => {
      // Arrange
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

      // Act
      await POST(makeRequest(), makeParams());

      // Assert: success flag reflects delivery outcome
      expect(mockLogInfo).toHaveBeenCalledTimes(1);
      expect(mockLogInfo).toHaveBeenCalledWith(
        'Webhook test sent',
        expect.objectContaining({
          webhookId: WEBHOOK_ID,
          url: WEBHOOK_URL,
          statusCode: 503,
          durationMs: expect.any(Number),
          success: false,
        })
      );
    });
  });
});
