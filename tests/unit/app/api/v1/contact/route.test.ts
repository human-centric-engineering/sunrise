/**
 * Unit Tests: POST /api/v1/contact Route
 *
 * Focused unit tests for the contact form submission endpoint covering
 * the key scenarios including the regression test for the missing `await`
 * on `sendEmail` that caused silent failures on Vercel serverless.
 *
 * Test Coverage:
 * - Happy path: valid submission stores in DB and sends email, returns 200
 * - Regression: sendEmail is awaited before the response returns
 * - Email failure is non-fatal: sendEmail returning { success: false } still returns 200
 * - Honeypot triggered: populated website field returns 200 silently, no DB write
 * - Validation errors: missing required fields return 400
 * - Rate limiting: exceeded rate limit returns 429
 * - No admin email configured: CONTACT_EMAIL and EMAIL_FROM both absent skips email, returns 200
 *
 * @see app/api/v1/contact/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/contact/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
 *
 * getRouteLogger is mocked globally in tests/setup.ts — no local mock needed.
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    contactSubmission: {
      create: vi.fn(),
    },
  },
}));

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

// Mock env module (with CONTACT_EMAIL set by default)
vi.mock('@/lib/env', () => ({
  env: {
    CONTACT_EMAIL: 'admin@example.com',
    EMAIL_FROM: 'noreply@example.com',
    NODE_ENV: 'test',
  },
}));

// Mock rate limiter
vi.mock('@/lib/security/rate-limit', () => ({
  contactLimiter: {
    check: vi.fn(),
  },
  getRateLimitHeaders: vi.fn(() => ({
    'X-RateLimit-Limit': '5',
    'X-RateLimit-Remaining': '4',
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
  })),
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': '3600',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      }
    )
  ),
}));

// Import mocked modules after vi.mock calls
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { contactLimiter } from '@/lib/security/rate-limit';
import { mockEmailSuccess, mockEmailFailure } from '@/tests/helpers/email';
import { env } from '@/lib/env';

/**
 * Response type interfaces for type-safe assertions
 */
interface SuccessResponseBody {
  success: true;
  data: { message: string };
}

interface ErrorResponseBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Helper: create a mock NextRequest with a JSON body
 */
function createMockRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/contact');
  return {
    json: async () => body,
    headers: new Headers(headers),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
  } as unknown as NextRequest;
}

/**
 * Helper: parse JSON from a Response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Helper: build a rate-limit result object
 */
function makeRateLimitResult(success: boolean, remaining = 4) {
  return {
    success,
    limit: 5,
    remaining,
    reset: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Valid contact form payload used across tests
 */
const validPayload = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  subject: 'Product question',
  message: 'I would like to know more about your pricing and features.',
};

/**
 * A realistic mock DB submission record
 */
function makeMockSubmission(overrides: Partial<typeof validPayload> = {}) {
  return {
    id: 'submission-001',
    ...validPayload,
    ...overrides,
    createdAt: new Date('2026-02-12T00:00:00.000Z'),
    read: false,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('POST /api/v1/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limit allows the request
    vi.mocked(contactLimiter.check).mockReturnValue(makeRateLimitResult(true));
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should store submission in DB, send email, and return 200 success', async () => {
      // Arrange
      const submission = makeMockSubmission();
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(submission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-001');

      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: HTTP 200 with the canonical success message
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Thank you for your message. We will get back to you soon.');

      // Assert: DB write was called with the correct fields
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledWith({
        data: {
          name: validPayload.name,
          email: validPayload.email,
          subject: validPayload.subject,
          message: validPayload.message,
        },
      });

      // Assert: Email notification was dispatched
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@example.com',
          subject: `[Sunrise Contact] ${validPayload.subject}`,
          replyTo: validPayload.email,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Regression: sendEmail is awaited before the response returns
  //
  // Prior bug: sendEmail() was called without await. On Vercel serverless the
  // function was killed mid-flight before Resend could make its network request.
  // Fix: await sendEmail(...).
  //
  // This test verifies the await semantics: we give sendEmail a deferred
  // promise and confirm that POST() does not settle until we resolve it.
  // If sendEmail were fire-and-forget the POST promise would resolve
  // immediately, making the assertions below fail.
  // ---------------------------------------------------------------------------

  describe('Regression: sendEmail is awaited (not fire-and-forget)', () => {
    it('should not resolve before sendEmail completes', async () => {
      // Arrange: create a deferred promise so we control when sendEmail resolves
      let resolveSendEmail!: (value: Awaited<ReturnType<typeof sendEmail>>) => void;
      const sendEmailDeferred = new Promise<Awaited<ReturnType<typeof sendEmail>>>((resolve) => {
        resolveSendEmail = resolve;
      });

      vi.mocked(sendEmail).mockReturnValue(sendEmailDeferred);
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(makeMockSubmission());

      const request = createMockRequest(validPayload);

      // Act: start the handler but do NOT await it yet
      const handlerPromise = POST(request);

      // Assert: give other microtasks a turn; the handler should still be pending
      // because sendEmail has not resolved yet
      let settled = false;
      void handlerPromise.then(() => {
        settled = true;
      });

      // Flush microtask queue without resolving sendEmail
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(false); // handler is blocked waiting for sendEmail

      // Now resolve sendEmail and let the handler finish
      resolveSendEmail({ success: true, status: 'sent', id: 'email-reg-001' });
      await handlerPromise;

      // Assert: sendEmail was called exactly once and the handler resolved
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Email send failure is non-fatal
  // ---------------------------------------------------------------------------

  describe('Email send failure is non-fatal', () => {
    it('should return 200 even when sendEmail returns { success: false }', async () => {
      // Arrange
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(makeMockSubmission());
      mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection refused');

      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: submission was saved and the user sees success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: submission was stored despite email failure
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Honeypot triggered
  // ---------------------------------------------------------------------------

  describe('Honeypot protection', () => {
    it('should return 200 silently without saving or emailing when website field is populated', async () => {
      // Arrange: include a non-empty honeypot field
      const botPayload = { ...validPayload, website: 'https://spam.example.com' };
      const request = createMockRequest(botPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: silent 200 to avoid tipping off the bot
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Thank you for your message. We will get back to you soon.');

      // Assert: no DB write and no email
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Validation errors
  // ---------------------------------------------------------------------------

  describe('Validation errors', () => {
    it('should return 400 when name is missing', async () => {
      // Arrange
      const { name: _name, ...withoutName } = validPayload;
      const request = createMockRequest(withoutName);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();
    });

    it('should return 400 when email is invalid', async () => {
      // Arrange
      const request = createMockRequest({ ...validPayload, email: 'not-an-email' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when message is too short (under 10 chars)', async () => {
      // Arrange
      const request = createMockRequest({ ...validPayload, message: 'Short' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when subject is missing', async () => {
      // Arrange
      const { subject: _subject, ...withoutSubject } = validPayload;
      const request = createMockRequest(withoutSubject);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Rate limiting
  // ---------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('should return 429 when the rate limit is exceeded', async () => {
      // Arrange: rate limiter signals the request is over limit
      vi.mocked(contactLimiter.check).mockReturnValue(makeRateLimitResult(false, 0));

      const request = createMockRequest(validPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert: 429 with the standard error envelope
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      // Assert: no DB write and no email when rate-limited
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. No admin email configured
  // ---------------------------------------------------------------------------

  describe('No admin email configured', () => {
    it('should skip email but still return 200 when CONTACT_EMAIL and EMAIL_FROM are both absent', async () => {
      // Arrange: strip both email env vars for this test
      const originalContactEmail = env.CONTACT_EMAIL;
      const originalEmailFrom = env.EMAIL_FROM;
      (env as Record<string, unknown>).CONTACT_EMAIL = undefined;
      (env as Record<string, unknown>).EMAIL_FROM = undefined;

      try {
        vi.mocked(prisma.contactSubmission.create).mockResolvedValue(makeMockSubmission());

        const request = createMockRequest(validPayload);

        // Act
        const response = await POST(request);
        const body = await parseResponse<SuccessResponseBody>(response);

        // Assert: handler succeeds
        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        // Assert: submission was stored
        expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledOnce();

        // Assert: no email was attempted
        expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      } finally {
        // Restore env values so other tests are unaffected
        (env as Record<string, unknown>).CONTACT_EMAIL = originalContactEmail;
        (env as Record<string, unknown>).EMAIL_FROM = originalEmailFrom;
      }
    });
  });
});
