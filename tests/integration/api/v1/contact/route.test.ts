/**
 * Integration Test: Contact Form Submission Endpoint
 *
 * Tests the POST /api/v1/contact endpoint for contact form submissions.
 *
 * Test Coverage:
 * - Successful submission (stores in DB, returns success, sends email)
 * - Validation errors (missing/invalid fields)
 * - Honeypot triggered (returns fake success but doesn't store)
 * - Rate limiting (blocks after 5 submissions per hour)
 * - Email sending (mocked, non-blocking)
 * - Client IP extraction
 *
 * @see app/api/v1/contact/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/contact/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
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

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    CONTACT_EMAIL: 'admin@sunrise.example.com',
    EMAIL_FROM: 'noreply@sunrise.example.com',
    NODE_ENV: 'test',
  },
}));

// Mock rate limiter
vi.mock('@/lib/security/rate-limit', () => ({
  contactLimiter: {
    check: vi.fn(),
  },
  getRateLimitHeaders: vi.fn((result) => ({
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  })),
  createRateLimitResponse: vi.fn((result) =>
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
          'Retry-After': String(Math.max(1, result.reset - Math.floor(Date.now() / 1000))),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': String(result.remaining),
          'X-RateLimit-Reset': String(result.reset),
        },
      }
    )
  ),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';
import { contactLimiter } from '@/lib/security/rate-limit';
import { mockEmailSuccess, mockEmailFailure } from '@/tests/helpers/email';

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/contact');

  return {
    json: async () => body,
    headers: new Headers(headers || {}),
    url: url.toString(),
    nextUrl: {
      searchParams: url.searchParams,
    },
  } as unknown as NextRequest;
}

/**
 * Helper function to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Response type interfaces
 */
interface SuccessResponse {
  success: true;
  data: {
    message: string;
  };
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Mock rate limit result
 */
function createMockRateLimitResult(success: boolean, remaining = 4) {
  const resetTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  return {
    success,
    limit: 5,
    remaining,
    reset: resetTime,
  };
}

/**
 * Valid contact form data
 */
const validContactData = {
  name: 'John Doe',
  email: 'john@example.com',
  subject: 'Question about Sunrise',
  message: 'I would like to learn more about your product. Can you provide more details?',
};

/**
 * Test Suite: POST /api/v1/contact
 */
describe('POST /api/v1/contact', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Default mock for rate limiter (allow by default)
    vi.mocked(contactLimiter.check).mockReturnValue(createMockRateLimitResult(true));
  });

  /**
   * Success Scenarios
   */
  describe('Success scenarios', () => {
    it('should create contact submission successfully and store in database', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-123',
        name: validContactData.name,
        email: validContactData.email,
        subject: validContactData.subject,
        message: validContactData.message,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-123');

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Response structure and values
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Thank you for your message. We will get back to you soon.');

      // Assert: Contact submission was stored in database
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledWith({
        data: {
          name: validContactData.name,
          email: validContactData.email,
          subject: validContactData.subject,
          message: validContactData.message,
        },
      });

      // Assert: Success logged
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Contact form submission created',
        expect.objectContaining({
          id: mockSubmission.id,
          email: validContactData.email,
          subject: validContactData.subject,
        })
      );
    });

    it('should send email notification to CONTACT_EMAIL', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-456',
        ...validContactData,
        createdAt: new Date('2024-01-01T12:00:00Z'),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-456');

      // Act
      const request = createMockRequest(validContactData);
      await POST(request);

      // Wait for promise to resolve (non-blocking email)
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert: Email was sent to admin
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith({
        to: 'admin@sunrise.example.com',
        subject: `[Sunrise Contact] ${validContactData.subject}`,
        react: expect.any(Object),
        replyTo: validContactData.email,
      });

      // Assert: Email success was logged
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Contact notification email sent',
        expect.objectContaining({
          submissionId: mockSubmission.id,
          emailId: 'email-id-456',
        })
      );
    });

    it('should fallback to EMAIL_FROM when CONTACT_EMAIL is not set', async () => {
      // Arrange: Override env mock temporarily
      const envModule = await import('@/lib/env');
      const originalContactEmail = envModule.env.CONTACT_EMAIL;
      (envModule.env as any).CONTACT_EMAIL = undefined;

      try {
        const mockSubmission = {
          id: 'contact-submission-789',
          ...validContactData,
          createdAt: new Date(),
          read: false,
        };
        vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
        mockEmailSuccess(vi.mocked(sendEmail), 'email-id-789');

        // Act
        const request = createMockRequest(validContactData);
        await POST(request);

        // Wait for promise to resolve
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert: Email was sent to EMAIL_FROM
        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'noreply@sunrise.example.com',
          })
        );
      } finally {
        // Restore original value
        (envModule.env as any).CONTACT_EMAIL = originalContactEmail;
      }
    });

    it('should continue successfully even if email sending fails', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-999',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection failed');

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Request still succeeds
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Contact was stored
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalled();

      // Wait for promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert: Warning was logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to send contact notification email',
        expect.objectContaining({
          submissionId: mockSubmission.id,
          error: 'SMTP connection failed',
        })
      );
    });

    it('should include rate limit headers in successful response', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-headers',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);

      // Assert: Rate limit headers present
      expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(response.headers.get('X-RateLimit-Remaining')).toBeDefined();
      expect(response.headers.get('X-RateLimit-Reset')).toBeDefined();
    });
  });

  /**
   * Validation Scenarios
   */
  describe('Validation scenarios', () => {
    it('should return 400 when name is missing', async () => {
      // Arrange
      const invalidData = { ...validContactData };
      delete (invalidData as any).name;

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');

      // Assert: No submission was created
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();
    });

    it('should return 400 when name is empty', async () => {
      // Arrange
      const invalidData = { ...validContactData, name: '' };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when name exceeds 100 characters', async () => {
      // Arrange
      const invalidData = { ...validContactData, name: 'a'.repeat(101) };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when email is invalid', async () => {
      // Arrange
      const invalidData = { ...validContactData, email: 'not-an-email' };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when email is missing', async () => {
      // Arrange
      const invalidData = { ...validContactData };
      delete (invalidData as any).email;

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when subject is missing', async () => {
      // Arrange
      const invalidData = { ...validContactData };
      delete (invalidData as any).subject;

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when subject exceeds 200 characters', async () => {
      // Arrange
      const invalidData = { ...validContactData, subject: 'a'.repeat(201) };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when message is missing', async () => {
      // Arrange
      const invalidData = { ...validContactData };
      delete (invalidData as any).message;

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when message is less than 10 characters', async () => {
      // Arrange
      const invalidData = { ...validContactData, message: 'Too short' };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when message exceeds 5000 characters', async () => {
      // Arrange
      const invalidData = { ...validContactData, message: 'a'.repeat(5001) };

      // Act
      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should trim whitespace from name, subject, and message fields', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-trim',
        name: 'John Doe',
        email: 'john@example.com',
        subject: 'Test Subject',
        message: 'Test message content here',
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithWhitespace = {
        name: '  John Doe  ',
        email: 'john@example.com', // Email cannot have leading/trailing spaces (invalid format)
        subject: '  Test Subject  ',
        message: '  Test message content here  ',
      };

      // Act
      const request = createMockRequest(dataWithWhitespace);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Trimmed values were stored
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledWith({
        data: {
          name: 'John Doe',
          email: 'john@example.com',
          subject: 'Test Subject',
          message: 'Test message content here',
        },
      });
    });
  });

  /**
   * Honeypot Protection Scenarios
   */
  describe('Honeypot protection', () => {
    it('should return fake success when honeypot field is filled', async () => {
      // Arrange
      const dataWithHoneypot = {
        ...validContactData,
        website: 'https://spam-bot.com',
      };

      // Act
      const request = createMockRequest(dataWithHoneypot);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Returns fake success to not tip off bot
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Thank you for your message. We will get back to you soon.');

      // Assert: NO submission was created
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();

      // Assert: Warning was logged (honeypot validation error triggers special handling)
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Contact form honeypot validation failed',
        expect.objectContaining({
          ip: '127.0.0.1',
        })
      );
    });

    it('should return fake success when honeypot field has any non-empty value', async () => {
      // Arrange
      const dataWithHoneypot = {
        ...validContactData,
        website: 'x',
      };

      // Act
      const request = createMockRequest(dataWithHoneypot);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Fake success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: NO submission was created
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();
    });

    it('should allow submission when honeypot field is empty string', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-honeypot-empty',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithEmptyHoneypot = {
        ...validContactData,
        website: '',
      };

      // Act
      const request = createMockRequest(dataWithEmptyHoneypot);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Real success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Submission WAS created
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalled();
    });

    it('should allow submission when honeypot field is not present', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-no-honeypot',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act: No website field at all
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Real success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Submission WAS created
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalled();
    });
  });

  /**
   * Rate Limiting Scenarios
   */
  describe('Rate limiting', () => {
    it('should allow submission when under rate limit', async () => {
      // Arrange
      vi.mocked(contactLimiter.check).mockReturnValue(createMockRateLimitResult(true, 3));

      const mockSubmission = {
        id: 'contact-submission-rate-limit-ok',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Submission was created
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalled();
    });

    it('should block submission when rate limit exceeded', async () => {
      // Arrange
      vi.mocked(contactLimiter.check).mockReturnValue(createMockRateLimitResult(false, 0));

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Rate limit error
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.message).toBe('Too many requests. Please try again later.');

      // Assert: Rate limit headers present
      expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('Retry-After')).toBeDefined();

      // Assert: NO submission was created
      expect(vi.mocked(prisma.contactSubmission.create)).not.toHaveBeenCalled();

      // Assert: Warning was logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Contact form rate limit exceeded',
        expect.objectContaining({
          remaining: 0,
        })
      );
    });

    it('should use client IP from x-forwarded-for header', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-ip',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validContactData, {
        'x-forwarded-for': '192.168.1.100, 10.0.0.1',
      });
      await POST(request);

      // Assert: Rate limiter was called with the first IP
      expect(vi.mocked(contactLimiter.check)).toHaveBeenCalledWith('192.168.1.100');
    });

    it('should use client IP from x-real-ip header when x-forwarded-for is not present', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-real-ip',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validContactData, {
        'x-real-ip': '203.0.113.45',
      });
      await POST(request);

      // Assert: Rate limiter was called with x-real-ip
      expect(vi.mocked(contactLimiter.check)).toHaveBeenCalledWith('203.0.113.45');
    });

    it('should fallback to "unknown" when no IP headers are present', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-unknown-ip',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validContactData);
      await POST(request);

      // Assert: Rate limiter was called with '127.0.0.1'
      expect(vi.mocked(contactLimiter.check)).toHaveBeenCalledWith('127.0.0.1');
    });
  });

  /**
   * Error Handling Scenarios
   */
  describe('Error handling', () => {
    it('should return 500 when database operation fails', async () => {
      // Arrange
      vi.mocked(prisma.contactSubmission.create).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Internal server error
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBeDefined();
    });

    it('should skip email notification when both CONTACT_EMAIL and EMAIL_FROM are not set', async () => {
      // Arrange: Override env mock
      const envModule = await import('@/lib/env');
      const originalContactEmail = envModule.env.CONTACT_EMAIL;
      const originalEmailFrom = envModule.env.EMAIL_FROM;
      (envModule.env as any).CONTACT_EMAIL = undefined;
      (envModule.env as any).EMAIL_FROM = undefined;

      try {
        const mockSubmission = {
          id: 'contact-submission-no-email',
          ...validContactData,
          createdAt: new Date(),
          read: false,
        };
        vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);

        // Act
        const request = createMockRequest(validContactData);
        const response = await POST(request);
        const body = await parseResponse<SuccessResponse>(response);

        // Assert: Request succeeds
        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        // Wait for promise resolution
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert: No email was sent
        expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();

        // Assert: Warning was logged
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'No CONTACT_EMAIL or EMAIL_FROM configured, skipping notification',
          expect.objectContaining({
            submissionId: mockSubmission.id,
          })
        );
      } finally {
        // Restore original values
        (envModule.env as any).CONTACT_EMAIL = originalContactEmail;
        (envModule.env as any).EMAIL_FROM = originalEmailFrom;
      }
    });

    it('should handle email sending exception gracefully', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-email-error',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      vi.mocked(sendEmail).mockRejectedValue(new Error('Network timeout'));

      // Act
      const request = createMockRequest(validContactData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Request still succeeds (email is non-blocking)
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Wait for promise resolution
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert: Error was logged
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error sending contact notification email',
        expect.any(Error),
        expect.objectContaining({
          submissionId: mockSubmission.id,
        })
      );
    });
  });

  /**
   * Edge Cases
   */
  describe('Edge cases', () => {
    it('should handle message with exactly 10 characters', async () => {
      // Arrange
      const mockSubmission = {
        id: 'contact-submission-min-message',
        ...validContactData,
        message: '1234567890',
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithMinMessage = {
        ...validContactData,
        message: '1234567890',
      };

      // Act
      const request = createMockRequest(dataWithMinMessage);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success (10 chars is valid)
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should handle message with exactly 5000 characters', async () => {
      // Arrange
      const longMessage = 'a'.repeat(5000);
      const mockSubmission = {
        id: 'contact-submission-max-message',
        ...validContactData,
        message: longMessage,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithMaxMessage = {
        ...validContactData,
        message: longMessage,
      };

      // Act
      const request = createMockRequest(dataWithMaxMessage);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success (5000 chars is valid)
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should handle special characters in message', async () => {
      // Arrange
      const specialMessage = 'Special chars: <script>alert("xss")</script> & "quotes" & emojis 🚀';
      const mockSubmission = {
        id: 'contact-submission-special-chars',
        ...validContactData,
        message: specialMessage,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithSpecialChars = {
        ...validContactData,
        message: specialMessage,
      };

      // Act
      const request = createMockRequest(dataWithSpecialChars);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success (special characters allowed)
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Special characters preserved in storage
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledWith({
        data: expect.objectContaining({
          message: specialMessage,
        }),
      });
    });

    it('should handle concurrent submissions from same IP', async () => {
      // Arrange
      vi.mocked(contactLimiter.check)
        .mockReturnValueOnce(createMockRateLimitResult(true, 4))
        .mockReturnValueOnce(createMockRateLimitResult(true, 3))
        .mockReturnValueOnce(createMockRateLimitResult(true, 2));

      const mockSubmission = {
        id: 'contact-submission-concurrent',
        ...validContactData,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.contactSubmission.create).mockResolvedValue(mockSubmission);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act: Send 3 concurrent requests
      const request1 = createMockRequest(validContactData);
      const request2 = createMockRequest(validContactData);
      const request3 = createMockRequest(validContactData);

      const [response1, response2, response3] = await Promise.all([
        POST(request1),
        POST(request2),
        POST(request3),
      ]);

      // Assert: All should succeed
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);

      // Assert: All submissions were created
      expect(vi.mocked(prisma.contactSubmission.create)).toHaveBeenCalledTimes(3);
    });
  });
});
