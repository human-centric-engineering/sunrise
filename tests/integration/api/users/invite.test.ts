/**
 * Integration Test: User Invitation Endpoint
 *
 * Tests the POST /api/v1/users/invite endpoint for inviting new users.
 *
 * Test Coverage:
 * - Successful invitation (stores in Verification table, NOT User table)
 * - Unauthorized (non-admin user)
 * - Unauthenticated (no session)
 * - User already exists (409 conflict)
 * - Invitation already exists (200 with existing details)
 * - Invalid input (validation errors)
 * - Email sending (mocked)
 *
 * Note: Phase 2 refactor - users NOT created until invitation acceptance
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
import { mockEmailSuccess, mockEmailFailure } from '@/tests/helpers/email';

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
    },
    verification: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock invitation token utilities
vi.mock('@/lib/utils/invitation-token', () => ({
  generateInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
  updateInvitationToken: vi.fn(),
}));

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

// Note: getRouteLogger is mocked globally in tests/setup.ts

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Mock rate limiting
vi.mock('@/lib/security/rate-limit', () => ({
  inviteLimiter: {
    check: vi.fn(() => ({
      success: true,
      limit: 10,
      remaining: 9,
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
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  generateInvitationToken,
  getValidInvitation,
  updateInvitationToken,
} from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
import { getRouteLogger } from '@/lib/api/context';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(body: unknown, queryParams?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/users/invite');
  if (queryParams) {
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  return {
    json: async () => body,
    headers: new Headers(),
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
    invitation: {
      email: string;
      name: string;
      role: string;
      invitedAt: string;
      expiresAt: string;
      link?: string; // Optional - not present when emailStatus is 'pending'
    };
    emailStatus: 'sent' | 'failed' | 'disabled' | 'pending';
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
    it('should create invitation successfully without creating user (admin user)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock no existing invitation (using new getValidInvitation)
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-123');

      // Mock email sending
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-123');

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
      expect(body.data.message).toBe('Invitation sent successfully');
      expect(body.data.emailStatus).toBe('sent');
      expect(body.data.invitation).toMatchObject({
        email: 'john@example.com',
        name: 'John Doe',
        role: 'USER',
      });
      expect(body.data.invitation.invitedAt).toBeDefined();
      expect(body.data.invitation.expiresAt).toBeDefined();
      expect(body.data.invitation.link).toContain('accept-invite');
      expect(body.data.invitation.link).toContain('invitation-token-123');

      // Assert: Invitation token was generated with metadata
      expect(vi.mocked(generateInvitationToken)).toHaveBeenCalledWith(
        'john@example.com',
        expect.objectContaining({
          name: 'John Doe',
          role: 'USER',
          invitedBy: adminSession.user.id,
        })
      );

      // Assert: Email was sent
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith({
        to: 'john@example.com',
        subject: "You've been invited to join Sunrise",
        react: expect.any(Object),
      });

      // Assert: Success logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Invitation created',
        expect.objectContaining({
          email: 'john@example.com',
          role: 'USER',
        })
      );
    });

    it('should create invitation with default role when not specified', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock no existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-456');

      // Mock email sending
      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        status: 'sent',
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
      expect(body.data.invitation.role).toBe('USER');
      expect(body.data.emailStatus).toBe('sent');
    });

    it('should continue even if email sending fails', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock no existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-789');

      // Mock email sending failure
      mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection failed');

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
      expect(body.data.message).toBe('Invitation created but email failed to send');
      expect(body.data.emailStatus).toBe('failed');
      expect(body.data.invitation.email).toBe('bob@example.com');

      // Assert: Warning was logged
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to send invitation email',
        expect.objectContaining({
          error: 'SMTP connection failed',
          emailStatus: 'failed',
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

      // Assert: No invitation was created
      expect(vi.mocked(prisma.verification.create)).not.toHaveBeenCalled();
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

      // Assert: No invitation was created
      expect(vi.mocked(prisma.verification.create)).not.toHaveBeenCalled();
    });
  });

  /**
   * Validation Scenarios
   */
  describe('Validation scenarios', () => {
    it('should return 409 when user already exists', async () => {
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
        bio: null,
        phone: null,
        timezone: 'UTC',
        location: null,
        preferences: {},
      });

      // Act: Call the invite endpoint with existing email
      const request = createMockRequest({
        name: 'New User',
        email: 'existing@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Email taken error (409 conflict)
      expect(response.status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('EMAIL_TAKEN');
      expect(body.error.message).toBe('User already exists with this email');

      // Assert: No invitation was created
      expect(vi.mocked(prisma.verification.create)).not.toHaveBeenCalled();
    });

    it('should return 200 with pending status and NO link when invitation already exists (without resend)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock existing invitation using getValidInvitation
      const existingInvitation = {
        email: 'existing@example.com',
        metadata: {
          name: 'Existing User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(getValidInvitation).mockResolvedValue(existingInvitation);

      // Act: Call the invite endpoint without resend param
      const request = createMockRequest({
        name: 'Existing User',
        email: 'existing@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Returns 200 with 'pending' status
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe(
        'Invitation already pending. Use ?resend=true to send a new invitation email.'
      );
      expect(body.data.emailStatus).toBe('pending');
      expect(body.data.invitation).toMatchObject({
        email: 'existing@example.com',
        name: 'Existing User',
        role: 'USER',
        invitedAt: '2024-01-01T00:00:00.000Z',
      });

      // Assert: NO link is returned (this is the bug fix)
      expect(body.data.invitation.link).toBeUndefined();

      // Assert: Logged existing invitation found
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Existing invitation found, not resending',
        expect.objectContaining({
          email: 'existing@example.com',
        })
      );

      // Assert: No new invitation was created
      expect(vi.mocked(generateInvitationToken)).not.toHaveBeenCalled();
      expect(vi.mocked(updateInvitationToken)).not.toHaveBeenCalled();
    });

    it('should resend invitation with new token when ?resend=true', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock existing invitation
      const existingInvitation = {
        email: 'resend@example.com',
        metadata: {
          name: 'Resend User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(getValidInvitation).mockResolvedValue(existingInvitation);

      // Mock updateInvitationToken (used for resend)
      vi.mocked(updateInvitationToken).mockResolvedValue('new-resend-token-123');

      // Mock email sending
      mockEmailSuccess(vi.mocked(sendEmail), 'resend-email-id');

      // Act: Call the invite endpoint WITH ?resend=true
      const request = createMockRequest(
        {
          name: 'Resend User',
          email: 'resend@example.com',
          role: 'USER',
        },
        { resend: 'true' }
      );
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Returns 201 with new token
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Invitation resent successfully');
      expect(body.data.emailStatus).toBe('sent');
      expect(body.data.invitation.link).toContain('new-resend-token-123');

      // Assert: updateInvitationToken was called (not generateInvitationToken)
      expect(vi.mocked(updateInvitationToken)).toHaveBeenCalledWith(
        'resend@example.com',
        expect.objectContaining({
          name: 'Resend User',
          role: 'USER',
          invitedBy: adminSession.user.id,
        })
      );
      expect(vi.mocked(generateInvitationToken)).not.toHaveBeenCalled();

      // Assert: Email was sent
      expect(vi.mocked(sendEmail)).toHaveBeenCalled();

      // Assert: Logged as resent
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Invitation resent',
        expect.objectContaining({
          email: 'resend@example.com',
          isResend: true,
        })
      );
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

      // Mock no existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-123');

      // Mock email sending
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-123');

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

    it('should log email success when email sends successfully', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock no existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-999');

      // Mock email sending success with ID
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-success-123');

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: Request succeeds
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);

      // Assert: Email success was logged with email ID and status
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Invitation email sent',
        expect.objectContaining({
          email: 'test@example.com',
          emailId: 'email-id-success-123',
          emailStatus: 'sent',
        })
      );
    });

    it('should use BETTER_AUTH_URL as fallback when NEXT_PUBLIC_APP_URL is not set', async () => {
      // Arrange: Temporarily override env mock to test fallback
      const envModule = await import('@/lib/env');
      const originalUrl = envModule.env.NEXT_PUBLIC_APP_URL;

      // Intentionally override for test (env is readonly in types)
      (envModule.env as any).NEXT_PUBLIC_APP_URL = undefined;

      // Also need to mock process.env for the fallback
      const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'http://auth.example.com';

      try {
        // Arrange: Mock admin session
        const adminSession = mockAdminUser();
        vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

        // Mock no existing user
        vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

        // Mock no existing invitation
        vi.mocked(getValidInvitation).mockResolvedValue(null);

        // Mock invitation token generation
        vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-fallback');

        // Mock email sending
        mockEmailSuccess(vi.mocked(sendEmail), 'email-id-fallback');

        // Act: Call the invite endpoint
        const request = createMockRequest({
          name: 'Fallback User',
          email: 'fallback@example.com',
          role: 'USER',
        });
        const response = await POST(request);
        const body = await parseResponse<SuccessResponse>(response);

        // Assert: Response includes invitation link with BETTER_AUTH_URL
        expect(response.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.data.invitation.link).toContain('http://auth.example.com');
        expect(body.data.invitation.link).toContain('accept-invite');
      } finally {
        // Restore original values
        (envModule.env as any).NEXT_PUBLIC_APP_URL = originalUrl;
        process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      }
    });

    it('should use localhost as fallback when both NEXT_PUBLIC_APP_URL and BETTER_AUTH_URL are not set', async () => {
      // Arrange: Temporarily override env mock to test final fallback
      const envModule = await import('@/lib/env');
      const originalUrl = envModule.env.NEXT_PUBLIC_APP_URL;

      // Intentionally override for test (env is readonly in types)
      (envModule.env as any).NEXT_PUBLIC_APP_URL = undefined;

      // Also need to mock process.env for the fallback
      const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
      delete process.env.BETTER_AUTH_URL;

      try {
        // Arrange: Mock admin session
        const adminSession = mockAdminUser();
        vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

        // Mock no existing user
        vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

        // Mock no existing invitation
        vi.mocked(getValidInvitation).mockResolvedValue(null);

        // Mock invitation token generation
        vi.mocked(generateInvitationToken).mockResolvedValue('invitation-token-localhost');

        // Mock email sending
        mockEmailSuccess(vi.mocked(sendEmail), 'email-id-localhost');

        // Act: Call the invite endpoint
        const request = createMockRequest({
          name: 'Localhost User',
          email: 'localhost@example.com',
          role: 'USER',
        });
        const response = await POST(request);
        const body = await parseResponse<SuccessResponse>(response);

        // Assert: Response includes invitation link with localhost
        expect(response.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.data.invitation.link).toContain('http://localhost:3000');
        expect(body.data.invitation.link).toContain('accept-invite');
      } finally {
        // Restore original values
        (envModule.env as any).NEXT_PUBLIC_APP_URL = originalUrl;
        if (originalBetterAuthUrl !== undefined) {
          process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
        }
      }
    });

    it('should not return link for existing invitation (security - prevents link reuse)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock existing invitation
      const existingInvitation = {
        email: 'security@example.com',
        metadata: {
          name: 'Security User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(getValidInvitation).mockResolvedValue(existingInvitation);

      // Act: Call the invite endpoint WITHOUT resend
      const request = createMockRequest({
        name: 'Security User',
        email: 'security@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: No link returned (security - can't generate valid link without new token)
      expect(response.status).toBe(200);
      expect(body.data.emailStatus).toBe('pending');
      expect(body.data.invitation.link).toBeUndefined();
    });

    it('should generate different tokens on each resend (security)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock existing invitation
      const existingInvitation = {
        email: 'security@example.com',
        metadata: {
          name: 'Security User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      };
      vi.mocked(getValidInvitation).mockResolvedValue(existingInvitation);

      // Mock different tokens for each resend
      vi.mocked(updateInvitationToken)
        .mockResolvedValueOnce('token-resend-1')
        .mockResolvedValueOnce('token-resend-2');

      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act: Resend twice
      const request1 = createMockRequest(
        { name: 'Security User', email: 'security@example.com', role: 'USER' },
        { resend: 'true' }
      );
      const response1 = await POST(request1);
      const body1 = await parseResponse<SuccessResponse>(response1);

      const request2 = createMockRequest(
        { name: 'Security User', email: 'security@example.com', role: 'USER' },
        { resend: 'true' }
      );
      const response2 = await POST(request2);
      const body2 = await parseResponse<SuccessResponse>(response2);

      // Assert: Each response has a different token
      expect(body1.data.invitation.link).toContain('token-resend-1');
      expect(body2.data.invitation.link).toContain('token-resend-2');
    });

    it('should use BETTER_AUTH_URL fallback when resending invitation', async () => {
      // Arrange: Temporarily override env mock to test fallback
      const envModule = await import('@/lib/env');
      const originalUrl = envModule.env.NEXT_PUBLIC_APP_URL;

      // Intentionally override for test (env is readonly in types)
      (envModule.env as any).NEXT_PUBLIC_APP_URL = undefined;

      const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'http://auth.example.com';

      try {
        // Arrange: Mock admin session
        const adminSession = mockAdminUser();
        vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

        // Mock no existing user
        vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

        // Mock existing invitation
        const existingInvitation = {
          email: 'resend-url@example.com',
          metadata: {
            name: 'Resend URL User',
            role: 'USER',
            invitedBy: 'admin-id',
            invitedAt: '2024-01-01T00:00:00.000Z',
          },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        };
        vi.mocked(getValidInvitation).mockResolvedValue(existingInvitation);

        // Mock updateInvitationToken
        vi.mocked(updateInvitationToken).mockResolvedValue('resend-token-url');

        // Mock email sending
        mockEmailSuccess(vi.mocked(sendEmail), 'email-id-resend-url');

        // Act: Call the invite endpoint with resend
        const request = createMockRequest(
          {
            name: 'Resend URL User',
            email: 'resend-url@example.com',
            role: 'USER',
          },
          { resend: 'true' }
        );
        const response = await POST(request);
        const body = await parseResponse<SuccessResponse>(response);

        // Assert: Response uses BETTER_AUTH_URL
        expect(response.status).toBe(201);
        expect(body.success).toBe(true);
        expect(body.data.invitation.link).toContain('http://auth.example.com');
        expect(body.data.invitation.link).toContain('accept-invite');
      } finally {
        // Restore original values
        (envModule.env as any).NEXT_PUBLIC_APP_URL = originalUrl;
        process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      }
    });
  });

  /**
   * Rate Limiting Scenarios
   */
  describe('Rate limiting', () => {
    it('should return 429 when rate limit is exceeded', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock rate limit exceeded
      vi.mocked(inviteLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Math.ceil((Date.now() + 900000) / 1000),
      });

      // Mock createRateLimitResponse to return 429
      vi.mocked(createRateLimitResponse).mockReturnValue(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
          }),
          { status: 429 }
        )
      );

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Rate Limited User',
        email: 'ratelimited@example.com',
        role: 'USER',
      });
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: Rate limit error
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.message).toBe('Too many requests.');
    });

    it('should log warning with IP and admin ID when rate limited', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock getClientIP to return specific IP
      vi.mocked(getClientIP).mockReturnValue('192.168.1.100');

      // Mock rate limit exceeded
      const rateLimitResult = {
        success: false,
        limit: 10,
        remaining: 0,
        reset: Math.ceil((Date.now() + 900000) / 1000),
      };
      vi.mocked(inviteLimiter.check).mockReturnValue(rateLimitResult);

      // Mock createRateLimitResponse
      vi.mocked(createRateLimitResponse).mockReturnValue(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
          }),
          { status: 429 }
        )
      );

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Rate Limited User',
        email: 'ratelimited@example.com',
        role: 'USER',
      });
      await POST(request);

      // Assert: Warning was logged with correct data
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.warn).toHaveBeenCalledWith('Invite rate limit exceeded', {
        ip: '192.168.1.100',
        adminId: adminSession.user.id,
        remaining: 0,
        reset: rateLimitResult.reset,
      });
    });

    it('should not proceed to validation or database queries when rate limited', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock rate limit exceeded
      vi.mocked(inviteLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Math.ceil((Date.now() + 900000) / 1000),
      });

      // Mock createRateLimitResponse
      vi.mocked(createRateLimitResponse).mockReturnValue(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
          }),
          { status: 429 }
        )
      );

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Rate Limited User',
        email: 'ratelimited@example.com',
        role: 'USER',
      });
      await POST(request);

      // Assert: No database queries were made
      expect(vi.mocked(prisma.user.findUnique)).not.toHaveBeenCalled();
      expect(vi.mocked(getValidInvitation)).not.toHaveBeenCalled();
      expect(vi.mocked(generateInvitationToken)).not.toHaveBeenCalled();

      // Assert: No email was sent
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it('should use client IP from getClientIP for rate limiting', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock getClientIP to return specific IP
      const testIP = '203.0.113.42';
      vi.mocked(getClientIP).mockReturnValue(testIP);

      // Mock rate limit check (success)
      vi.mocked(inviteLimiter.check).mockReturnValue({
        success: true,
        limit: 10,
        remaining: 9,
        reset: Math.ceil((Date.now() + 900000) / 1000),
      });

      // Mock no existing user
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Mock no existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Mock invitation token generation
      vi.mocked(generateInvitationToken).mockResolvedValue('token-123');

      // Mock email sending
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-123');

      // Act: Call the invite endpoint
      const request = createMockRequest({
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
      });
      await POST(request);

      // Assert: getClientIP was called with the request
      expect(vi.mocked(getClientIP)).toHaveBeenCalledWith(request);

      // Assert: inviteLimiter.check was called with the client IP
      expect(vi.mocked(inviteLimiter.check)).toHaveBeenCalledWith(testIP);
    });
  });
});
