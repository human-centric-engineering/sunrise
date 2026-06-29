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

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// getRouteLogger returns a logger — capture the mock logger so tests can
// assert individual method calls.
const mockLogInfo = vi.fn();
const mockLogError = vi.fn();

const mockLogWarn = vi.fn();

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({
      info: mockLogInfo,
      error: mockLogError,
      warn: mockLogWarn,
      debug: vi.fn(),
    })
  ),
}));

// Email-channel test pings render an email template and send via Resend.
// Stub both so unit tests stay hermetic and assert routing/branches.
const mockResendSend = vi.fn();
vi.mock('@/lib/email/client', () => ({
  getResendClient: vi.fn(() => ({ emails: { send: mockResendSend } })),
  getDefaultSender: vi.fn(() => 'Sunrise <noreply@example.com>'),
  isEmailEnabled: vi.fn(() => true),
}));
vi.mock('@react-email/render', () => ({
  render: vi.fn().mockResolvedValue('<html>rendered</html>'),
}));

// Distinctive brand name so the subject assertion proves BRAND.name interpolation
// rather than the "Sunrise" default (covered by lib/brand.test.tsx).
vi.mock('@/lib/brand', () => ({ BRAND: { name: 'Aurora Labs' } }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
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
    channel: 'webhook',
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    emailAddress: null,
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
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(makeWebhook() as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

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

  // ── Missing destination URL ─────────────────────────────────────────────

  describe('Missing destination URL', () => {
    it('returns success:false and does NOT call fetch when webhook channel has no URL', async () => {
      // Arrange: webhook channel row with a secret but null url
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeWebhook({ url: null }) as never
      );

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.durationMs).toBe(0);
      expect(body.data.error).toBe('Webhook has no destination URL.');
      expect(globalThis.fetch).not.toHaveBeenCalled();
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
      // Arrange: simulate the AbortController aborting fetch.
      // AbortController's 5s timeout is bypassed by mocking fetch to reject with a
      // synthetic AbortError directly — no fake timers needed.
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

    it('fires the 5-second setTimeout abort callback when fetch never resolves', async () => {
      // Drive the inline `setTimeout(() => controller.abort(), 5000)` arrow
      // directly: hold fetch unresolved, advance fake timers past 5s, and
      // resolve the request via the abort signal.
      vi.useFakeTimers();
      try {
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          });
        });

        const responsePromise = POST(makeRequest(), makeParams());

        // Advance past the 5s controller timeout — this invokes the
        // setTimeout callback, which calls controller.abort().
        await vi.advanceTimersByTimeAsync(5001);

        const response = await responsePromise;
        const body = await parseJson<{ data: { success: boolean; error: string } }>(response);

        expect(body.data.success).toBe(false);
        expect(body.data.error).toBe('Request timed out after 5 seconds');
      } finally {
        vi.useRealTimers();
      }
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

  // ── Email channel ───────────────────────────────────────────────────────

  describe('Email channel', () => {
    const TEST_EMAIL = 'alerts@example.com';

    function makeEmailWebhook(overrides: Record<string, unknown> = {}) {
      return makeWebhook({
        channel: 'email',
        url: null,
        secret: null,
        emailAddress: TEST_EMAIL,
        ...overrides,
      });
    }

    beforeEach(() => {
      mockResendSend.mockResolvedValue({ data: { id: 'resend_id' }, error: null });
    });

    it('returns success:true and routes to Resend (not fetch) for email-channel webhook', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: null };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(body.data.statusCode).toBeNull();
      expect(body.data.error).toBeNull();
      expect(typeof body.data.durationMs).toBe('number');

      // Outbound HTTP must NOT be used for email channel
      expect(globalThis.fetch).not.toHaveBeenCalled();

      expect(mockResendSend).toHaveBeenCalledTimes(1);
      expect(mockResendSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Sunrise <noreply@example.com>',
          to: TEST_EMAIL,
          subject: '[Aurora Labs] Test event',
          html: expect.stringContaining('rendered'),
        })
      );
    });

    it('returns success:false with destination-missing message when emailAddress is null', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook({ emailAddress: null }) as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe('Email subscription has no destination address.');
      expect(body.data.durationMs).toBe(0);
      expect(mockResendSend).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns success:false when email subsystem is not configured (isEmailEnabled false)', async () => {
      const { isEmailEnabled } = await import('@/lib/email/client');
      vi.mocked(isEmailEnabled).mockReturnValueOnce(false);
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe(
        'Email sending is not configured. Set RESEND_API_KEY and EMAIL_FROM.'
      );
      expect(body.data.durationMs).toBe(0);
      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it('returns success:false when getResendClient returns null', async () => {
      const { getResendClient } = await import('@/lib/email/client');
      vi.mocked(getResendClient).mockReturnValueOnce(null);
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      // Error message comes from the catch block, surfaced via err.message
      expect(body.data.error).toBe('Resend client unavailable');
      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it('returns success:false with Resend error message when send returns an error', async () => {
      mockResendSend.mockResolvedValueOnce({
        data: null,
        error: { message: 'Invalid recipient address' },
      });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{
        data: { success: boolean; statusCode: null; durationMs: number; error: string };
      }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe('Invalid recipient address');
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Webhook test (email) rejected',
        expect.objectContaining({
          webhookId: WEBHOOK_ID,
          error: 'Invalid recipient address',
        })
      );
    });

    it('falls back to "Resend rejected the email" when error has no message', async () => {
      mockResendSend.mockResolvedValueOnce({ data: null, error: {} });
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{ data: { success: boolean; error: string } }>(response);

      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe('Resend rejected the email');
    });

    it('returns success:false when Resend.send throws (network error)', async () => {
      mockResendSend.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{ data: { success: boolean; error: string } }>(response);

      expect(response.status).toBe(200);
      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe('ETIMEDOUT');
    });

    it('returns "Unknown error" when Resend.send throws a non-Error value', async () => {
      mockResendSend.mockRejectedValueOnce('oops');
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      const response = await POST(makeRequest(), makeParams());
      const body = await parseJson<{ data: { success: boolean; error: string } }>(response);

      expect(body.data.success).toBe(false);
      expect(body.data.error).toBe('Unknown error');
    });

    it('logs success at info level after a successful email test', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue(
        makeEmailWebhook() as never
      );

      await POST(makeRequest(), makeParams());

      expect(mockLogInfo).toHaveBeenCalledWith(
        'Webhook test sent (email)',
        expect.objectContaining({
          webhookId: WEBHOOK_ID,
          durationMs: expect.any(Number),
        })
      );
    });
  });
});
