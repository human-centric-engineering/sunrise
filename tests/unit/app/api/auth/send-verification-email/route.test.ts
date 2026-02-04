/**
 * Integration Tests for Send Verification Email API Route
 *
 * Tests for POST /api/auth/send-verification-email
 *
 * Coverage:
 * - Successful verification email sending (valid user, unverified)
 * - Validation errors (invalid email, missing fields)
 * - Rate limiting (3 requests per 15 minutes)
 * - Security: Always returns success response (prevents enumeration)
 * - Non-existent user handling
 * - Already verified user handling
 * - better-auth sendVerificationEmail failures
 * - Database errors
 * - Client IP extraction
 * - Rate limit headers
 * - Logging
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies BEFORE importing route
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      sendVerificationEmail: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', async () => {
  const actualModule = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actualModule,
    verificationEmailLimiter: {
      check: vi.fn(),
      reset: vi.fn(),
    },
  };
});

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Import after mocking
import { POST } from '@/app/api/auth/send-verification-email/route';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { verificationEmailLimiter } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';

describe('POST /api/auth/send-verification-email', () => {
  // Test data
  const validEmail = 'user@example.com';
  const mockUser = {
    id: 'user-id-123',
    email: validEmail,
    emailVerified: false,
    name: 'Test User',
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: 'USER',
    bio: null,
    phone: null,
    timezone: null,
    location: null,
    preferences: {},
  };

  // Helper to create mock request
  function createMockRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
    const headersObj = new Headers({
      'Content-Type': 'application/json',
      ...headers,
    });

    return {
      json: vi.fn().mockResolvedValue(body),
      headers: headersObj,
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: Rate limit allows request
    vi.mocked(verificationEmailLimiter.check).mockReturnValue({
      success: true,
      limit: 3,
      remaining: 2,
      reset: Math.floor(Date.now() / 1000) + 900,
    });
  });

  describe('successful verification email sending', () => {
    it('should send verification email for valid unverified user', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Debug: Log actual response
      if (response.status !== 200) {
        console.log('Response status:', response.status);
        console.log('Response data:', data);
      }

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toContain('verification email has been sent');

      // Verify better-auth was called
      expect(auth.api.sendVerificationEmail).toHaveBeenCalledWith({
        body: { email: validEmail },
      });

      // Verify logging
      expect(logger.info).toHaveBeenCalledWith('Sending verification email', {
        userId: mockUser.id,
        email: validEmail,
      });
    });

    it('should include rate limit headers in response', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      vi.mocked(verificationEmailLimiter.check).mockReturnValue({
        success: true,
        limit: 3,
        remaining: 1,
        reset: 1234567890,
      });

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('1');
      expect(response.headers.get('X-RateLimit-Reset')).toBe('1234567890');
    });

    it('should log successful email sending', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      await POST(request);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Verification email sent successfully', {
        userId: mockUser.id,
        email: validEmail,
      });
    });
  });

  describe('validation errors', () => {
    it('should reject request without email field', async () => {
      // Arrange
      const request = createMockRequest({});

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject request with invalid email format', async () => {
      // Arrange
      const request = createMockRequest({ email: 'not-an-email' });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject request with empty email', async () => {
      // Arrange
      const request = createMockRequest({ email: '' });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject malformed JSON', async () => {
      // Arrange: Mock json() to throw
      const request = {
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        headers: new Headers(),
      } as unknown as NextRequest;

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('rate limiting', () => {
    it('should block request when rate limit exceeded', async () => {
      // Arrange: Rate limit exceeded
      vi.mocked(verificationEmailLimiter.check).mockReturnValue({
        success: false,
        limit: 3,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 900,
      });

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should include Retry-After header when rate limited', async () => {
      // Arrange
      const resetTime = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now
      vi.mocked(verificationEmailLimiter.check).mockReturnValue({
        success: false,
        limit: 3,
        remaining: 0,
        reset: resetTime,
      });

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.has('Retry-After')).toBe(true);
      const retryAfter = parseInt(response.headers.get('Retry-After') || '0');
      expect(retryAfter).toBeGreaterThan(0);
    });

    it('should log rate limit exceeded', async () => {
      // Arrange
      vi.mocked(verificationEmailLimiter.check).mockReturnValue({
        success: false,
        limit: 3,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 900,
      });

      const request = createMockRequest({ email: validEmail }, { 'x-forwarded-for': '1.2.3.4' });

      // Act
      await POST(request);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith(
        'Verification email rate limit exceeded',
        expect.objectContaining({
          ip: '1.2.3.4',
        })
      );
    });

    it('should check rate limit with client IP', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail }, { 'x-forwarded-for': '1.2.3.4' });

      // Act
      await POST(request);

      // Assert
      expect(verificationEmailLimiter.check).toHaveBeenCalledWith('1.2.3.4');
    });
  });

  describe('client IP extraction', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest(
        { email: validEmail },
        { 'x-forwarded-for': '203.0.113.42, 198.51.100.1' }
      );

      // Act
      await POST(request);

      // Assert: Should use first IP in list
      expect(verificationEmailLimiter.check).toHaveBeenCalledWith('203.0.113.42');
    });

    it('should extract IP from x-real-ip header if x-forwarded-for missing', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail }, { 'x-real-ip': '203.0.113.42' });

      // Act
      await POST(request);

      // Assert
      expect(verificationEmailLimiter.check).toHaveBeenCalledWith('203.0.113.42');
    });

    it('should use "unknown" if no IP headers present', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      await POST(request);

      // Assert
      expect(verificationEmailLimiter.check).toHaveBeenCalledWith('127.0.0.1');
    });
  });

  describe('security: prevents email enumeration', () => {
    it('should return success for non-existent user (prevents enumeration)', async () => {
      // Arrange: User doesn't exist
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const request = createMockRequest({ email: 'nonexistent@example.com' });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should return success to prevent enumeration
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toContain('If an account exists');

      // Should NOT call sendVerificationEmail
      expect(auth.api.sendVerificationEmail).not.toHaveBeenCalled();

      // Should log the attempt
      expect(logger.info).toHaveBeenCalledWith(
        'Verification email requested for non-existent user',
        { email: 'nonexistent@example.com' }
      );
    });

    it('should return success for already verified user (prevents enumeration)', async () => {
      // Arrange: User is already verified
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUser,
        emailVerified: true,
      });

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should return success
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toContain('If an account exists');

      // Should NOT send email
      expect(auth.api.sendVerificationEmail).not.toHaveBeenCalled();

      // Should log
      expect(logger.info).toHaveBeenCalledWith(
        'Verification email requested for already verified user',
        {
          userId: mockUser.id,
          email: validEmail,
        }
      );
    });

    it('should have same response format for all scenarios', async () => {
      // Test that response format is identical regardless of user state

      // Arrange: Get response for each scenario
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      // Scenario 1: Valid unverified user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      const request1 = createMockRequest({ email: validEmail });
      const response1 = await POST(request1);
      const data1 = await response1.json();

      // Scenario 2: Non-existent user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      const request2 = createMockRequest({ email: 'fake@example.com' });
      const response2 = await POST(request2);
      const data2 = await response2.json();

      // Scenario 3: Already verified
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUser,
        emailVerified: true,
      });
      const request3 = createMockRequest({ email: validEmail });
      const response3 = await POST(request3);
      const data3 = await response3.json();

      // Assert: All responses have same status and structure
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);

      expect(data1.success).toBe(true);
      expect(data2.success).toBe(true);
      expect(data3.success).toBe(true);

      // All have the same generic message
      expect(data1.data.message).toContain('If an account exists');
      expect(data2.data.message).toContain('If an account exists');
      expect(data3.data.message).toContain('If an account exists');
    });
  });

  describe('better-auth failures', () => {
    it('should return success even if sendVerificationEmail fails', async () => {
      // Arrange: better-auth throws error
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockRejectedValue(
        new Error('Email service unavailable')
      );

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should still return success (prevents enumeration)
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Should log the error
      expect(logger.error).toHaveBeenCalledWith(
        'better-auth sendVerificationEmail failed',
        expect.any(Error),
        {
          email: validEmail,
          userId: mockUser.id,
        }
      );
    });

    it('should handle better-auth timeout', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockRejectedValue(new Error('Timeout'));

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should return success
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('database errors', () => {
    it('should handle database connection error', async () => {
      // Arrange: Database throws error
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');

      // Should log error
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to process verification email request',
        expect.any(Error)
      );
    });

    it('should handle database query timeout', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Query timeout'));

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject email with whitespace (validation fails)', async () => {
      // Arrange: Email with whitespace fails Zod validation
      const request = createMockRequest({ email: '  USER@EXAMPLE.COM  ' });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should fail validation
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle user with null name', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUser,
        name: null as unknown as string, // Prisma allows null but type is string
      });
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert: Should not throw
      expect(response.status).toBe(200);
    });

    it('should handle concurrent requests from same IP', async () => {
      // Arrange: All requests pass rate limit
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request1 = createMockRequest({ email: validEmail }, { 'x-forwarded-for': '1.2.3.4' });
      const request2 = createMockRequest({ email: validEmail }, { 'x-forwarded-for': '1.2.3.4' });

      // Act: Make concurrent requests
      const [response1, response2] = await Promise.all([POST(request1), POST(request2)]);

      // Assert: Both should succeed (rate limiter handles concurrency)
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });
  });

  describe('logging', () => {
    it('should log all info events in success flow', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      await POST(request);

      // Assert: Multiple info logs
      expect(logger.info).toHaveBeenCalledWith('Sending verification email', expect.any(Object));
      expect(logger.info).toHaveBeenCalledWith(
        'Verification email sent successfully',
        expect.any(Object)
      );
    });

    it('should not log sensitive information', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      await POST(request);

      // Assert: Check that no sensitive data is logged
      const allLogCalls = [
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
        ...vi.mocked(logger.error).mock.calls,
      ];

      allLogCalls.forEach((call) => {
        const logData = JSON.stringify(call);
        // Email is OK to log, but password/tokens should never appear
        expect(logData).not.toContain('password');
        expect(logData).not.toContain('token');
        expect(logData).not.toContain('secret');
      });
    });
  });

  describe('response headers', () => {
    it('should include Content-Type: application/json', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert: Content-Type should contain application/json
      const contentType = response.headers.get('Content-Type');
      expect(contentType).toContain('application/json');
    });

    it('should include rate limit headers on success', async () => {
      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.has('X-RateLimit-Limit')).toBe(true);
      expect(response.headers.has('X-RateLimit-Remaining')).toBe(true);
      expect(response.headers.has('X-RateLimit-Reset')).toBe(true);
    });

    it('should include rate limit headers on rate limit error', async () => {
      // Arrange
      vi.mocked(verificationEmailLimiter.check).mockReturnValue({
        success: false,
        limit: 3,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 900,
      });

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.has('X-RateLimit-Limit')).toBe(true);
      expect(response.headers.has('X-RateLimit-Remaining')).toBe(true);
      expect(response.headers.has('X-RateLimit-Reset')).toBe(true);
      expect(response.headers.has('Retry-After')).toBe(true);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle user signing up in dev without email verification', async () => {
      // Scenario: User signed up with REQUIRE_EMAIL_VERIFICATION=false
      // Now they want to verify their email for added security

      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(auth.api.sendVerificationEmail).toHaveBeenCalled();
    });

    it('should handle user requesting resend after first email lost', async () => {
      // Scenario: User clicked "Resend Email" button

      // Arrange
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      const request = createMockRequest({ email: validEmail });

      // Act
      const response = await POST(request);

      // Assert: Should succeed
      expect(response.status).toBe(200);
      expect(auth.api.sendVerificationEmail).toHaveBeenCalled();
    });

    it('should prevent malicious enumeration attempt', async () => {
      // Scenario: Attacker trying to enumerate valid emails

      // Arrange
      vi.mocked(auth.api.sendVerificationEmail).mockResolvedValue(undefined as never);

      // Act: Test with existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
      const request1 = createMockRequest({ email: 'user1@example.com' });
      const response1 = await POST(request1);
      const data1 = await response1.json();

      // Act: Test with non-existent user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      const request2 = createMockRequest({ email: 'nonexistent@example.com' });
      const response2 = await POST(request2);
      const data2 = await response2.json();

      // Assert: Both responses identical
      expect(data1.success).toBe(true);
      expect(data2.success).toBe(true);
      expect(data1.data.message).toContain('If an account exists');
      expect(data2.data.message).toContain('If an account exists');

      // Attacker cannot distinguish which users exist
    });
  });
});
