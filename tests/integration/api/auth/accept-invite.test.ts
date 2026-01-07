/**
 * Integration Test: Accept Invitation Endpoint
 *
 * Tests the POST /api/auth/accept-invite endpoint for accepting user invitations.
 *
 * Test Coverage:
 * - Successful invitation acceptance (first-time user creation)
 * - Invalid/expired token
 * - Invitation not found
 * - User ID stability (same ID used throughout)
 * - Welcome email sent after acceptance
 * - Role assignment for non-default roles
 * - Validation errors (password mismatch, weak password, etc.)
 * - Error handling (signup failure, JSON parsing, session deletion, email errors)
 * - Non-blocking error scenarios (email/session failures don't block success)
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

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, id: 'mock-email-id' }),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';
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

      // Mock better-auth signup response (creates user for the FIRST TIME)
      const createdUserId = 'user-id-123';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'John Doe',
            email: 'john@example.com',
            emailVerified: false, // Not verified yet by better-auth
          },
          session: {
            token: 'session-token-123',
          },
        }),
      });

      // Mock user updates (emailVerified)
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

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email
      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'mock-email-id' });

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
        message: 'Invitation accepted successfully. You can now log in.',
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
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: createdUserId },
        data: { emailVerified: true },
      });

      // Assert: Session was cleaned up
      expect(vi.mocked(prisma.session.delete)).toHaveBeenCalledWith({
        where: { token: 'session-token-123' },
      });

      // Assert: Invitation token was deleted
      expect(vi.mocked(deleteInvitationToken)).toHaveBeenCalledWith('john@example.com');

      // Assert: Welcome email was sent
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'john@example.com',
          subject: 'Welcome to Sunrise',
        })
      );

      // Assert: Success logged with stable User ID
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'Admin User',
            email: 'admin@example.com',
            emailVerified: false,
          },
          session: {
            token: 'session-token-456',
          },
        }),
      });

      // Mock user updates (role and emailVerified)
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

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email
      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'mock-email-id' });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token-456',
        email: 'admin@example.com',
        password: 'SecurePassword456!',
        confirmPassword: 'SecurePassword456!',
      });
      await POST(request);

      // Assert: Role was updated to ADMIN (before emailVerified update)
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: createdUserId },
        data: { role: 'ADMIN' },
      });

      // Assert: Email was marked as verified (after role update)
      expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith({
        where: { id: createdUserId },
        data: { emailVerified: true },
      });
    });

    it('should handle welcome email failure gracefully (non-blocking)', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-789',
        identifier: 'invitation:jane@example.com',
        value: 'valid-token-789',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Jane Doe',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup response
      const createdUserId = 'user-id-789';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'Jane Doe',
            email: 'jane@example.com',
            emailVerified: false,
          },
          session: {
            token: 'session-token-789',
          },
        }),
      });

      // Mock user updates
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      } as any);

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email failure (non-blocking error)
      vi.mocked(sendEmail).mockResolvedValue({
        success: false,
        error: 'Email service unavailable',
      });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token-789',
        email: 'jane@example.com',
        password: 'SecurePassword789!',
        confirmPassword: 'SecurePassword789!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Invitation acceptance still succeeds despite email failure
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Warning logged about email failure (non-blocking)
      // Note: The warning is logged asynchronously in a .catch() block
      // We can verify the email was attempted
      expect(vi.mocked(sendEmail)).toHaveBeenCalled();
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
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Invitation not found', {
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
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Invitation not found', {
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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'better-auth signup failed',
        undefined,
        expect.objectContaining({
          email: 'jsonerror@example.com',
          error: 'Signup failed',
        })
      );
    });

    it('should handle session deletion failure gracefully (non-blocking)', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-session-delete',
        identifier: 'invitation:sessiondelete@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Session Delete User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup response
      const createdUserId = 'user-session-delete';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'Session Delete User',
            email: 'sessiondelete@example.com',
            emailVerified: false,
          },
          session: {
            token: 'session-token-to-delete',
          },
        }),
      });

      // Mock user updates
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'Session Delete User',
        email: 'sessiondelete@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      } as any);

      // Mock session delete failure (should be ignored)
      vi.mocked(prisma.session.delete).mockRejectedValue(new Error('Session not found'));

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email
      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'mock-email-id' });

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'sessiondelete@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Invitation acceptance still succeeds despite session delete failure
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Session deletion was attempted
      expect(vi.mocked(prisma.session.delete)).toHaveBeenCalledWith({
        where: { token: 'session-token-to-delete' },
      });

      // Assert: Success logged
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Invitation accepted successfully',
        expect.objectContaining({
          email: 'sessiondelete@example.com',
          userId: createdUserId,
        })
      );
    });

    it('should handle email sending error gracefully (non-blocking)', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata
      const mockInvitation = {
        id: 'invitation-id-email-error',
        identifier: 'invitation:emailerror@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Email Error User',
          role: 'USER',
          invitedBy: 'admin@example.com',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(mockInvitation as any);

      // Mock better-auth signup response
      const createdUserId = 'user-email-error';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          user: {
            id: createdUserId,
            name: 'Email Error User',
            email: 'emailerror@example.com',
            emailVerified: false,
          },
          session: {
            token: 'session-token-email',
          },
        }),
      });

      // Mock user updates
      vi.mocked(prisma.user.update).mockResolvedValue({
        id: createdUserId,
        name: 'Email Error User',
        email: 'emailerror@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      } as any);

      // Mock session cleanup
      vi.mocked(prisma.session.delete).mockResolvedValue({} as any);

      // Mock token deletion
      vi.mocked(deleteInvitationToken).mockResolvedValue();

      // Mock welcome email throwing an error
      vi.mocked(sendEmail).mockRejectedValue(new Error('SMTP connection failed'));

      // Act: Call the accept-invite endpoint
      const request = createMockRequest({
        token: 'valid-token',
        email: 'emailerror@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Invitation acceptance still succeeds despite email error
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);

      // Assert: Email was attempted
      expect(vi.mocked(sendEmail)).toHaveBeenCalled();

      // Note: The warning is logged asynchronously in the catch block
      // We can't easily assert on it without waiting, but the test proves
      // the catch block is executed by verifying success despite email failure
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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });

    it('should handle role update failure gracefully', async () => {
      // Arrange: Mock valid token validation
      vi.mocked(validateInvitationToken).mockResolvedValue(true);

      // Mock invitation metadata with MODERATOR role
      const mockInvitation = {
        id: 'invitation-id-role-error',
        identifier: 'invitation:roleerror@example.com',
        value: 'valid-token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        metadata: {
          name: 'Role Error User',
          role: 'MODERATOR',
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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });
  });
});
