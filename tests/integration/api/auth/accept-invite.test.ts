/**
 * Integration Test: Accept Invitation Endpoint
 *
 * Tests the POST /api/auth/accept-invite endpoint for accepting user invitations.
 *
 * Test Coverage:
 * - Successful invitation acceptance (first-time user creation)
 * - Session cookie forwarding for auto-login
 * - Empty cookie headers handling
 * - Role assignment (USER, ADMIN)
 * - Invalid/expired token validation
 * - Invitation not found scenarios
 * - Missing invitation metadata
 * - Input validation (password mismatch, weak password, invalid email, missing fields)
 * - better-auth signup failures (duplicate email, JSON parsing errors)
 * - better-auth sign-in failures after successful signup
 * - User update failures (role assignment errors)
 * - Database errors
 * - Invitation token deletion verification
 * - Operation ordering verification
 *
 * @see app/api/auth/accept-invite/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/auth/accept-invite/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findFirst: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
    session: {
      delete: vi.fn(),
    },
  },
}));

// Mock invitation token utilities
vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
}));

// Note: getRouteLogger is mocked globally in tests/setup.ts

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, status: 'sent', id: 'mock-email-id' }),
}));

// Mock rate limiting
vi.mock('@/lib/security/rate-limit', () => ({
  acceptInviteLimiter: {
    check: vi.fn(() => ({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Math.ceil((Date.now() + 900000) / 1000),
    })),
  },
  createRateLimitResponse: vi.fn(
    () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        }),
        { status: 429 }
      )
  ),
  getRateLimitHeaders: vi.fn(() => ({
    'X-RateLimit-Limit': '5',
    'X-RateLimit-Remaining': '4',
    'X-RateLimit-Reset': String(Math.ceil((Date.now() + 900000) / 1000)),
  })),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { getRouteLogger } from '@/lib/api/context';
import { sendEmail } from '@/lib/email/send';

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    nextUrl: {
      searchParams: new URLSearchParams(),
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
 * Mock global fetch for better-auth signup endpoint
 */
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

/**
 * Test Suite: POST /api/auth/accept-invite
 */
describe('POST /api/auth/accept-invite', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  /**
   * Endpoint Verification
   *
   * This test verifies the endpoint file exists at the expected path
   * and prevents URL mismatches between tests and implementation.
   */
  it('should have POST handler at /api/auth/accept-invite', () => {
    // Verify the POST handler is defined and callable
    expect(POST).toBeDefined();
    expect(typeof POST).toBe('function');
  });

  /**
   * Success Scenarios
   */
  describe('Success scenarios', () => {
    it('should accept invitation successfully and create user for the first time', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-123',
        identifier: 'invitation:john@example.com',
        value: 'valid-token-123',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'John Doe',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup and sign-in responses
      const createdUserId = 'user-id-123';
      mockFetch
        // First call: signup (creates user for the FIRST TIME)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: {
              id: createdUserId,
              name: 'John Doe',
              email: 'john@example.com',
              emailVerified: false, // Not verified yet by better-auth
            },
          }),
          headers: {
            getSetCookie: () => [], // No cookies from signup (verification required)
          },
        })
        // Second call: sign-in (after emailVerified is set)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: {
              id: createdUserId,
              name: 'John Doe',
              email: 'john@example.com',
              emailVerified: true,
            },
            session: {
              token: 'session-token-123',
            },
          }),
          headers: {
            getSetCookie: () => [
              'better-auth.session_token=session-token-123; Path=/; HttpOnly; Secure; SameSite=Lax',
              'better-auth.state=some-state; Path=/; HttpOnly; Secure; SameSite=Lax',
            ],
          },
        });

      // Mock user update (emailVerified set immediately after signup)
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      } as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email
      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        status: 'sent',
        id: 'mock-email-id',
      });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token-123',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Response structure and values
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        message: 'Invitation accepted successfully. Redirecting to dashboard...',
      });

      // Assert: Token was validated
      expect(vi.mocked(validateInvitationToken)).toHaveBeenCalledWith(
        'john@example.com',
        'valid-token-123'
      );

      // Assert: Invitation metadata was fetched
      expect(vi.mocked(prisma.verification.findFirst)).toHaveBeenCalledWith({
        where: { identifier: 'invitation:john@example.com' },
      });

      // Assert: User was created via better-auth signup (FIRST TIME)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/sign-up/email',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Better-Auth': 'true',
          }),
          body: JSON.stringify({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'SecurePassword123!',
          }),
        })
      );

      // Assert: Email was marked as verified (same User ID used)
      // For USER role (default), role is undefined in the update
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: createdUserId },
        data: {
          emailVerified: true,
          role: undefined, // USER is default, so role field is undefined
        },
      });

      // Assert: Invitation token was deleted
      expect(vi.mocked(deleteInvitationToken)).toHaveBeenCalledWith('john@example.com');

      // Assert: Welcome email was NOT sent by endpoint (handled by database hook)
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();

      // Assert: Success logged with stable User ID
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Invitation accepted successfully',
        expect.objectContaining({
          email: 'john@example.com',
          userId: createdUserId,
        })
      );
    });

    it('should assign non-default role when accepting invitation', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata with ADMIN role
      const mockInvitation = {
        id: 'invitation-id-456',
        identifier: 'invitation:admin@example.com',
        value: 'valid-token-456',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Admin User',
          role: 'ADMIN', // Non-default role
          invitedBy: 'superadmin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup response (creates USER by default)
      const createdUserId = 'admin-id-123';
      mockFetch
        // First call: signup
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: {
              id: createdUserId,
              name: 'Admin User',
              email: 'admin@example.com',
              emailVerified: false,
            },
          }),
          headers: {
            getSetCookie: () => [], // No cookies from signup (verification required)
          },
        })
        // Second call: sign-in (after emailVerified is set)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: {
              id: createdUserId,
              name: 'Admin User',
              email: 'admin@example.com',
              emailVerified: true,
            },
            session: {
              token: 'session-token-456',
            },
          }),
          headers: {
            getSetCookie: () => [
              'better-auth.session_token=session-token-456; Path=/; HttpOnly; Secure; SameSite=Lax',
              'better-auth.state=some-state; Path=/; HttpOnly; Secure; SameSite=Lax',
            ],
          },
        });

      // Mock user update (role and emailVerified set together)
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      } as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token-456',
        email: 'admin@example.com',
        password: 'SecurePassword456!',
        confirmPassword: 'SecurePassword456!',
      });
      await POST(request);

      // Assert: Role AND emailVerified were updated together (single update)
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: createdUserId },
        data: {
          emailVerified: true,
          role: 'ADMIN',
        },
      });

      // Assert: Sign-in endpoint was called AFTER user update
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'http://localhost:3000/api/auth/sign-in/email',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Better-Auth': 'true',
          }),
          body: JSON.stringify({
            email: 'admin@example.com',
            password: 'SecurePassword456!',
          }),
        })
      );
    });

    it.skip('REMOVED: Welcome email now sent by database hook, not by accept-invite endpoint', async () => {
      // This test is no longer relevant because:
      // - Welcome email is sent automatically by the database hook in lib/auth/config.ts
      // - The accept-invite endpoint no longer calls sendEmail()
      // - Email failures are handled by the hook, not this endpoint
    });

    it('should forward session cookies for auto-login', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-cookies',
        identifier: 'invitation:cookies@example.com',
        value: 'valid-token-cookies',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Cookie User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      const createdUserId = 'user-id-cookies';
      const sessionCookies = [
        'better-auth.session_token=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
        'better-auth.state=xyz789; Path=/; HttpOnly; Secure; SameSite=Lax',
      ];

      mockFetch
        // First call: signup
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: { id: createdUserId, name: 'Cookie User', email: 'cookies@example.com' },
          }),
          headers: {
            getSetCookie: () => [],
          },
        })
        // Second call: sign-in (returns session cookies)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: {
              id: createdUserId,
              name: 'Cookie User',
              email: 'cookies@example.com',
              emailVerified: true,
            },
            session: { token: 'session-token-abc' },
          }),
          headers: {
            getSetCookie: () => sessionCookies,
          },
        });

      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'Cookie User',
        email: 'cookies@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act
      const request = createMockRequest({
        token: 'valid-token-cookies',
        email: 'cookies@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);

      // Assert: Response contains forwarded cookies
      const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
      expect(setCookieHeaders).toHaveLength(2);
      expect(setCookieHeaders[0]).toContain('better-auth.session_token');
      expect(setCookieHeaders[1]).toContain('better-auth.state');

      // Assert: Cookies logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session cookies forwarded to client',
        expect.objectContaining({
          userId: createdUserId,
          cookieCount: 2,
        })
      );
    });

    it('should handle empty cookie headers gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      const mockInvitation = {
        id: 'invitation-id-no-cookies',
        identifier: 'invitation:nocookies@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'No Cookie User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      const createdUserId = 'user-id-no-cookies';
      mockFetch
        // First call: signup
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: { id: createdUserId },
          }),
          headers: {
            getSetCookie: () => [],
          },
        })
        // Second call: sign-in (no cookies returned)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: { id: createdUserId, emailVerified: true },
            session: { token: 'session-token' },
          }),
          headers: {
            getSetCookie: () => [],
          },
        });

      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        emailVerified: true,
      } as any);

      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act
      const request = createMockRequest({
        token: 'valid-token',
        email: 'nocookies@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success despite no cookies
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: No cookies logged (should not call logger.info for cookies)
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'Session cookies forwarded to client',
        expect.anything()
      );
    });
  });

  /**
   * Token Validation Scenarios
   */
  describe('Token validation scenarios', () => {
    it('should return 400 when token is invalid', async () => {
      // Arrange: Mock invalid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      // Act: Call the accept-invite endpoint with invalid token
      const request = createMockRequest({
        token: 'invalid-token',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Invalid token error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invalid or expired invitation token');

      // Assert: Token validation was called
      expect(vi.mocked(validateInvitationToken)).toHaveBeenCalledWith(
        'john@example.com',
        'invalid-token'
      );

      // Assert: No invitation metadata lookup was performed
      expect(vi.mocked(prisma.verification.findFirst)).not.toHaveBeenCalled();

      // Assert: Warning logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid invitation token', {
        email: 'john@example.com',
      });
    });

    it('should return 400 when token is expired', async () => {
      // Arrange: Mock expired token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      // Act: Call the accept-invite endpoint with expired token
      const request = createMockRequest({
        token: 'expired-token',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Invalid or expired token error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invalid or expired invitation token');
    });
  });

  /**
   * Invitation Metadata Scenarios
   */
  describe('Invitation metadata scenarios', () => {
    it('should return 404 when invitation metadata not found', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation not found
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'nonexistent@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Invitation not found error
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Invitation not found');

      // Assert: Warning logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.warn).toHaveBeenCalledWith('Invitation not found', {
        email: 'nonexistent@example.com',
      });

      // Assert: No signup attempt was made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return 404 when invitation has no metadata', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation without metadata
      const mockInvitation = {
        id: 'invitation-id-999',
        identifier: 'invitation:corrupted@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: null, // Missing metadata
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'corrupted@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Invitation not found error
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Invitation not found');

      // Assert: Warning logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.warn).toHaveBeenCalledWith('Invitation not found', {
        email: 'corrupted@example.com',
      });

      // Assert: No signup attempt was made
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  /**
   * Input Validation Scenarios
   */
  describe('Input validation scenarios', () => {
    it('should return 400 when password and confirmPassword do not match', async () => {
      // Act: Call the accept-invite endpoint with mismatched passwords
      const request = createMockRequest({
        token: 'valid-token',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'DifferentPassword456!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toBeDefined();

      // Assert: No token validation was attempted
      expect(vi.mocked(validateInvitationToken)).not.toHaveBeenCalled();
    });

    it('should return 400 when password is too weak', async () => {
      // Act: Call the accept-invite endpoint with weak password
      const request = createMockRequest({
        token: 'valid-token',
        email: 'john@example.com',
        password: 'weak',
        confirmPassword: 'weak',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toBeDefined();
    });

    it('should return 400 when email is invalid', async () => {
      // Act: Call the accept-invite endpoint with invalid email
      const request = createMockRequest({
        token: 'valid-token',
        email: 'not-an-email',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when token is missing', async () => {
      // Act: Call the accept-invite endpoint without token
      const request = createMockRequest({
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when email is missing', async () => {
      // Act: Call the accept-invite endpoint without email
      const request = createMockRequest({
        token: 'valid-token',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  /**
   * Error Handling Scenarios
   */
  describe('Error handling scenarios', () => {
    it('should handle better-auth signup failure gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-error',
        identifier: 'invitation:error@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Error User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup failure
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          message: 'Email already exists',
        }),
      });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'error@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to create user account');

      // Assert: Error logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'better-auth signup failed',
        undefined,
        expect.objectContaining({
          email: 'error@example.com',
          error: 'Email already exists',
        })
      );
    });

    it('should handle better-auth signup response JSON parsing failure', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-json-error',
        identifier: 'invitation:jsonerror@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'JSON Error User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup failure with JSON parsing error
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'jsonerror@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response with fallback message
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to create user account');

      // Assert: Error logged with fallback error message
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'better-auth signup failed',
        undefined,
        expect.objectContaining({
          email: 'jsonerror@example.com',
          error: 'Signup failed',
        })
      );
    });

    it.skip('REMOVED: Session is now kept for auto-login, not deleted', async () => {
      // This test is no longer relevant because:
      // - Session is now kept for auto-login (consistent with OAuth invitation flow)
      // - The accept-invite endpoint no longer deletes the session
      // - Users are redirected to dashboard, not login
    });

    it.skip('REMOVED: Welcome email now sent by database hook, not by accept-invite endpoint', async () => {
      // This test is no longer relevant because:
      // - Welcome email is sent automatically by the database hook in lib/auth/config.ts
      // - The accept-invite endpoint no longer calls sendEmail()
      // - Email errors are handled by the hook, not this endpoint
    });

    it('should handle database errors gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock database error when fetching invitation
      vi.mocked(prisma.verification.findFirst).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);

      // Assert: Error logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });

    it('should handle role update failure gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata with ADMIN role
      const mockInvitation = {
        id: 'invitation-id-role-error',
        identifier: 'invitation:roleerror@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Role Error User',
          role: 'ADMIN',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup response
      const createdUserId = 'user-role-error';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'Role Error User',
            email: 'roleerror@example.com',
            emailVerified: false,
          },
          session: {
            token: 'session-token-role',
          },
        }),
        headers: {
          getSetCookie: () => [
            'better-auth.session_token=session-token-role; Path=/; HttpOnly; Secure; SameSite=Lax',
            'better-auth.state=some-state; Path=/; HttpOnly; Secure; SameSite=Lax',
          ],
        },
      });

      // Mock role update failure
      vi.mocked(prisma.user.update)
        .mockRejectedValueOnce(new Error('Database constraint violation'))
        .mockResolvedValueOnce({
          id: createdUserId,
          name: 'Role Error User',
          email: 'roleerror@example.com',
          role: 'USER',
          emailVerified: true,
          image: null,
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        } as any);

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'roleerror@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response (role update failed)
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);

      // Assert: Error logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });

    it('should handle sign-in failure after successful user creation', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      const mockInvitation = {
        id: 'invitation-id-signin-error',
        identifier: 'invitation:signinerror@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Sign-in Error User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      const createdUserId = 'user-signin-error';
      mockFetch
        // First call: signup (succeeds)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: { id: createdUserId, email: 'signinerror@example.com' },
          }),
          headers: {
            getSetCookie: () => [],
          },
        })
        // Second call: sign-in (fails)
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({
            message: 'Email verification required',
          }),
        });

      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        emailVerified: true,
      } as any);

      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act
      const request = createMockRequest({
        token: 'valid-token',
        email: 'signinerror@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('User created but failed to create session');

      // Assert: Sign-in error logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'better-auth sign-in failed after invitation acceptance',
        undefined,
        expect.objectContaining({
          email: 'signinerror@example.com',
          userId: createdUserId,
          error: 'Email verification required',
        })
      );
    });

    it('should handle sign-in response JSON parsing failure', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      const mockInvitation = {
        id: 'invitation-id-signin-json',
        identifier: 'invitation:signinjson@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Sign-in JSON Error',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      const createdUserId = 'user-signin-json';
      mockFetch
        // First call: signup (succeeds)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            user: { id: createdUserId },
          }),
          headers: {
            getSetCookie: () => [],
          },
        })
        // Second call: sign-in (JSON parsing fails)
        .mockResolvedValueOnce({
          ok: false,
          json: async () => {
            throw new Error('Invalid JSON');
          },
        });

      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        emailVerified: true,
      } as any);

      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act
      const request = createMockRequest({
        token: 'valid-token',
        email: 'signinjson@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response with fallback message
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('User created but failed to create session');

      // Assert: Error logged with fallback message
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'better-auth sign-in failed after invitation acceptance',
        undefined,
        expect.objectContaining({
          email: 'signinjson@example.com',
          error: 'Sign-in failed',
        })
      );
    });

    it('should return 500 when user already exists (duplicate email)', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      const mockInvitation = {
        id: 'invitation-id-duplicate',
        identifier: 'invitation:duplicate@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Duplicate User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup failure (email exists)
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          message: 'User with this email already exists',
        }),
      });

      // Act
      const request = createMockRequest({
        token: 'valid-token',
        email: 'duplicate@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Error response
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to create user account');

      // Assert: Error logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.error).toHaveBeenCalledWith(
        'better-auth signup failed',
        undefined,
        expect.objectContaining({
          email: 'duplicate@example.com',
          error: 'User with this email already exists',
        })
      );

      // Assert: No user update was attempted
      expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();

      // Assert: No token deletion was attempted
      expect(vi.mocked(deleteInvitationToken)).not.toHaveBeenCalled();
    });

    it('should verify invitation token is deleted after successful acceptance', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      const mockInvitation = {
        id: 'invitation-id-deletion',
        identifier: 'invitation:deletion@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Deletion Test User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      const createdUserId = 'user-deletion-test';
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { id: createdUserId } }),
          headers: { getSetCookie: () => [] },
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { id: createdUserId }, session: { token: 'token' } }),
          headers: { getSetCookie: () => [] },
        });

      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        emailVerified: true,
      } as any);

      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act
      const request = createMockRequest({
        token: 'valid-token',
        email: 'deletion@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Success
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Token deletion was called AFTER user update but BEFORE sign-in
      expect(vi.mocked(deleteInvitationToken)).toHaveBeenCalledWith('deletion@example.com');
      expect(vi.mocked(deleteInvitationToken)).toHaveBeenCalledTimes(1);

      // Assert: Verify call order (update, delete, sign-in)
      const updateCallOrder = vi.mocked(prisma.user.update).mock.invocationCallOrder[0];
      const deleteCallOrder = vi.mocked(deleteInvitationToken).mock.invocationCallOrder[0];
      const signInCallOrder = mockFetch.mock.invocationCallOrder[1]; // Second fetch is sign-in

      expect(updateCallOrder).toBeLessThan(deleteCallOrder);
      expect(deleteCallOrder).toBeLessThan(signInCallOrder);
    });
  });
});
