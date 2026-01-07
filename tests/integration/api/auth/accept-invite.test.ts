/**
 * Integration Test: Accept Invitation Endpoint
 *
 * Tests the POST /api/auth/accept-invite endpoint for accepting user invitations.
 *
 * Test Coverage:
 * - Successful invitation acceptance
 * - Invalid/expired token
 * - User not found
 * - Invitation already accepted (user has password)
 * - Validation errors (password mismatch, weak password, etc.)
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
    user: {
      findUnique: vi.fn(),
      delete: vi.fn(),
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
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';

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
    email: string;
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
    it('should accept invitation successfully with valid token', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock user without password (invited but not accepted yet)
      const mockUser = {
        id: 'user-id-123',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        accounts: [], // No credential account yet
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      // Mock user deletion (before re-creation via signup)
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock better-auth signup response
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: 'new-user-id-456',
            name: 'John Doe',
            email: 'john@example.com',
            emailVerified: true,
          },
          session: {
            token: 'session-token-123',
          },
        }),
      });

      // Mock user updates (role, image, emailVerified)
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUser,
        id: 'new-user-id-456',
        emailVerified: true,
      } as any);

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

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
        message: 'Invitation accepted successfully. You can now sign in.',
        email: 'john@example.com',
      });

      // Assert: Token was validated
      expect(vi.mocked(validateInvitationToken)).toHaveBeenCalledWith(
        'john@example.com',
        'valid-token-123'
      );

      // Assert: User was found
      expect(vi.mocked(prisma.user.findUnique)).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
        include: {
          accounts: {
            where: { providerId: 'credential' },
          },
        },
      });

      // Assert: Old user was deleted
      expect(vi.mocked(prisma.user.delete)).toHaveBeenCalledWith({
        where: { id: 'user-id-123' },
      });

      // Assert: User was re-created via better-auth signup
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/sign-up/email',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'John Doe',
            email: 'john@example.com',
            password: 'SecurePassword123!',
          }),
        })
      );

      // Assert: Email was marked as verified
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: 'new-user-id-456' },
        data: { emailVerified: true },
      });

      // Assert: Session was cleaned up
      expect(vi.mocked(prisma.session.delete)).toHaveBeenCalledWith({
        where: { token: 'session-token-123' },
      });

      // Assert: Invitation token was deleted
      expect(vi.mocked(deleteInvitationToken)).toHaveBeenCalledWith('john@example.com');

      // Assert: Success logged
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Invitation accepted successfully',
        expect.objectContaining({
          email: 'john@example.com',
          userId: 'new-user-id-456',
        })
      );
    });

    it('should preserve user role when accepting invitation', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock ADMIN user without password
      const mockAdminUser = {
        id: 'admin-id-123',
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: false,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        accounts: [],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdminUser as any);

      // Mock user deletion
      vi.mocked(prisma.user.delete).mockResolvedValue(mockAdminUser as any);

      // Mock better-auth signup response (creates USER by default)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: 'new-admin-id-456',
            name: 'Admin User',
            email: 'admin@example.com',
            emailVerified: true,
          },
          session: {
            token: 'session-token-456',
          },
        }),
      });

      // Mock user updates
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockAdminUser,
        id: 'new-admin-id-456',
        emailVerified: true,
      } as any);

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

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

      // Assert: Role was updated to ADMIN
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: 'new-admin-id-456' },
        data: { role: 'ADMIN' },
      });
    });

    it('should preserve user image when accepting invitation', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock user with image
      const mockUser = {
        id: 'user-id-789',
        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'USER',
        emailVerified: false,
        image: 'https://example.com/avatar.jpg',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        accounts: [],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      // Mock user deletion
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock better-auth signup response
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: 'new-user-id-789',
            name: 'Jane Doe',
            email: 'jane@example.com',
            emailVerified: true,
          },
          session: {
            token: 'session-token-789',
          },
        }),
      });

      // Mock user updates
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUser,
        id: 'new-user-id-789',
        emailVerified: true,
      } as any);

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token-789',
        email: 'jane@example.com',
        password: 'SecurePassword789!',
        confirmPassword: 'SecurePassword789!',
      });
      await POST(request);

      // Assert: Image was preserved
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: 'new-user-id-789' },
        data: { image: 'https://example.com/avatar.jpg' },
      });
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

      // Assert: No user lookup was performed
      expect(vi.mocked(prisma.user.findUnique)).not.toHaveBeenCalled();

      // Assert: Warning logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Invalid invitation token', {
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
   * User Validation Scenarios
   */
  describe('User validation scenarios', () => {
    it('should return 404 when user not found', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock user not found
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'nonexistent@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: User not found error
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('User not found');

      // Assert: Warning logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('User not found for invitation', {
        email: 'nonexistent@example.com',
      });
    });

    it('should return 400 when invitation already accepted (user has password)', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock user with credential account and password
      const mockUser = {
        id: 'user-id-123',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        accounts: [
          {
            id: 'account-id-123',
            providerId: 'credential',
            password: 'hashed-password', // User already has password
            accountId: 'john@example.com',
            userId: 'user-id-123',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2024-01-01T00:00:00.000Z'),
            accessToken: null,
            refreshToken: null,
            idToken: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            scope: null,
          },
        ],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'john@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Invitation already accepted error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Invitation already accepted');

      // Assert: Warning logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Invitation already accepted',
        expect.objectContaining({
          email: 'john@example.com',
          userId: 'user-id-123',
        })
      );

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

      // Mock user without password
      const mockUser = {
        id: 'user-id-123',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        accounts: [],
      };
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      // Mock user deletion
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock better-auth signup failure
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          message: 'Signup failed',
        }),
      });

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
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock database error
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });
  });
});
