/**
 * Integration Test: User Invitation Endpoint
 *
 * Tests the POST /api/v1/users/invite endpoint for inviting new users.
 *
 * Test Coverage:
 * - Successful invitation (admin user)
 * - Unauthorized (non-admin user)
 * - Unauthenticated (no session)
 * - Duplicate email (user already exists)
 * - Invalid input (validation errors)
 * - Email sending (mocked)
 *
 * @see app/api/v1/users/invite/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/users/invite/route';
import type { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

/**
 * Mock dependencies
 */

// Mock better-auth config
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock invitation token utilities
vi.mock('@/lib/utils/invitation-token', () => ({
  generateInvitationToken: vi.fn(),
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
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { generateInvitationToken } from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
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
    id: string;
    name: string;
    email: string;
    role: string;
    emailVerified: boolean;
    createdAt: string;
    status: string;
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
 * Test Suite: POST /api/v1/users/invite
 */
describe('POST /api/v1/users/invite', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  /**
   * Success Scenarios
   */
  describe('Success scenarios', () => {
    it('should invite user successfully (admin user)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock user creation
      const mockUser = {
        id: 'new-user-id',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: false,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(prisma.user.create).mockResolvedValue(mockUser as never);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-123');

      // Mock email sending
      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        id: 'email-id-123',
      });

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Response structure and values
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        id: 'new-user-id',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: false,
        status: 'invited',
      });

      // Assert: User was created without password
      expect(vi.mocked(prisma.user.create)).toHaveBeenCalledWith({
        data: {
          name: 'John Doe',
          email: 'john@example.com',
          emailVerified: false,
          role: 'USER',
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          createdAt: true,
        },
      });

      // Assert: Invitation token was generated
      expect(vi.mocked(generateInvitationToken)).toHaveBeenCalledWith('john@example.com');

      // Assert: Email was sent
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith({
        to: 'john@example.com',
        subject: "You've been invited to join Sunrise",
        react: expect.any(Object),
      });

      // Assert: Success logged
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'User created via invitation',
        expect.objectContaining({
          userId: 'new-user-id',
          email: 'john@example.com',
        })
      );
    });

    it('should invite user with default role when not specified', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock user creation
      const mockUser = {
        id: 'new-user-id',
        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'USER',
        emailVerified: false,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(prisma.user.create).mockResolvedValue(mockUser as never);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-456');

      // Mock email sending
      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        id: 'email-id-456',
      });

      // Act: Call the invite endpoint without specifying role
      const request = createMockRequest({
        name: 'Jane Doe',
        email: 'jane@example.com',
        // role not specified
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Response has default USER role
      expect(response.status).toBe(201);
      expect(body.data.role).toBe('USER');
    });

    it('should continue even if email sending fails', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock user creation
      const mockUser = {
        id: 'new-user-id',
        name: 'Bob Smith',
        email: 'bob@example.com',
        role: 'USER',
        emailVerified: false,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(prisma.user.create).mockResolvedValue(mockUser as never);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-789');

      // Mock email sending failure
      vi.mocked(sendEmail).mockResolvedValue({
        success: false,
        error: 'SMTP connection failed',
      });

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Bob Smith',
        email: 'bob@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Request still succeeds (201) despite email failure
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('invited');

      // Assert: Warning was logged
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to send invitation email',
        expect.objectContaining({
          error: 'SMTP connection failed',
        })
      );
    });
  });

  /**
   * Authorization Scenarios
   */
  describe('Authorization scenarios', () => {
    it('should return 401 when not authenticated', async () => {
      // Arrange: Mock no session
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Unauthorized error
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');

      // Assert: No user was created
      expect(vi.mocked(prisma.user.create)).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', async () => {
      // Arrange: Mock non-admin session
      const userSession = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(userSession as never);

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Forbidden error
      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Admin access required');

      // Assert: No user was created
      expect(vi.mocked(prisma.user.create)).not.toHaveBeenCalled();
    });
  });

  /**
   * Validation Scenarios
   */
  describe('Validation scenarios', () => {
    it('should return 400 when email already exists', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'existing-user-id',
        name: 'Existing User',
        email: 'existing@example.com',
        role: 'USER',
        emailVerified: true,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        image: null,
      });

      // Act: Call the invite endpoint with existing email
      const request = createMockRequest({
        name: 'New User',
        email: 'existing@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Email taken error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('EMAIL_TAKEN');
      expect(body.error.message).toBe('Email already in use');

      // Assert: No user was created
      expect(vi.mocked(prisma.user.create)).not.toHaveBeenCalled();
    });

    it('should return 400 when name is missing', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act: Call the invite endpoint without name
      const request = createMockRequest({
        email: 'john@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when email is invalid', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act: Call the invite endpoint with invalid email
      const request = createMockRequest({
        name: 'John Doe',
        email: 'not-an-email',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Validation error
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when role is invalid', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act: Call the invite endpoint with invalid role
      const request = createMockRequest({
        name: 'John Doe',
        email: 'john@example.com',
        role: 'SUPER_ADMIN', // Invalid role
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
   * Edge Cases
   */
  describe('Edge cases', () => {
    it('should handle inviter without name gracefully', async () => {
      // Arrange: Mock admin session without name
      const adminSession = mockAdminUser();
      // Override name to null
      adminSession.user.name = null as unknown as string;
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock user creation
      const mockUser = {
        id: 'new-user-id',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: false,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(prisma.user.create).mockResolvedValue(mockUser as never);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-123');

      // Mock email sending
      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        id: 'email-id-123',
      });

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Request succeeds
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);

      // Assert: Email was sent (inviterName should default to "Administrator")
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'john@example.com',
        })
      );
    });
  });
});
