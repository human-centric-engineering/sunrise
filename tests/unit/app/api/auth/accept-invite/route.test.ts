/**
 * Unit Tests for Accept Invitation API Route
 *
 * Tests for POST /api/auth/accept-invite
 *
 * Coverage:
 * - Successful invitation acceptance (valid token, email, password)
 * - Validation errors (missing fields, invalid password format)
 * - Password confirmation mismatch
 * - Invalid/expired invitation tokens
 * - User already exists
 * - better-auth signup failures
 * - better-auth sign-in failures
 * - Session cookie forwarding
 * - HTTP method handling (only POST allowed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies BEFORE importing the route

// Mock route logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('@/lib/api/context', async () => {
  return {
    getRouteLogger: vi.fn(async () => mockLogger),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findFirst: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      signUpEmail: vi.fn(),
      signInEmail: vi.fn(),
    },
  },
}));

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

// Import mocked modules after mocking
import { POST } from '@/app/api/auth/accept-invite/route';
import { prisma } from '@/lib/db/client';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';
import { auth } from '@/lib/auth/config';

describe('POST /api/auth/accept-invite', () => {
  // Test data
  const validInvitationData = {
    token: 'valid-token-123',
    email: 'user@example.com',
    password: 'SecurePass123!',
    confirmPassword: 'SecurePass123!',
  };

  const mockInvitationMetadata = {
    name: 'John Doe',
    role: 'USER',
    invitedBy: 'admin-user-id',
    invitedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockUserId = 'cmjbv4i3x00003wsloputgwul';

  // Helper to create mock request
  function createMockRequest(body: unknown) {
    return {
      json: vi.fn().mockResolvedValue(body),
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(validateInvitationToken).mockResolvedValue(true);
    vi.mocked(prisma.verification.findFirst).mockResolvedValue({
      id: 'verification-id',
      identifier: 'invitation:user@example.com',
      value: 'hashed-token',
      expiresAt: new Date('2024-12-31'),
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      metadata: mockInvitationMetadata,
    });
    vi.mocked(deleteInvitationToken).mockResolvedValue();

    // Default auth.api mocks
    vi.mocked(auth.api.signUpEmail).mockResolvedValue({
      user: { id: mockUserId },
      token: null,
    } as any);
    vi.mocked(auth.api.signInEmail).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [] },
    } as any);

    // Default prisma.user.update mock
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: mockUserId,
      emailVerified: true,
    } as any);
  });

  describe('successful invitation acceptance', () => {
    it('should accept invitation and create user with valid data', async () => {
      // Arrange: Mock successful better-auth signup and sign-in
      const mockSessionCookies = [
        'better-auth.session_token=abc123; Path=/; HttpOnly; SameSite=Lax',
        'better-auth.csrf_token=xyz789; Path=/; HttpOnly; SameSite=Lax',
      ];

      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => mockSessionCookies },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Returns success response
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toContain('Invitation accepted successfully');

      // Verify invitation token was validated
      expect(validateInvitationToken).toHaveBeenCalledWith(
        validInvitationData.email,
        validInvitationData.token
      );

      // Verify invitation metadata was fetched
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: { identifier: `invitation:${validInvitationData.email}` },
      });

      // Verify better-auth signup was called with correct body
      expect(vi.mocked(auth.api.signUpEmail)).toHaveBeenCalledWith({
        body: {
          name: mockInvitationMetadata.name,
          email: validInvitationData.email,
          password: validInvitationData.password,
        },
      });

      // Verify user was updated with emailVerified=true and role
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: {
          emailVerified: true,
          role: undefined, // USER role is default, so undefined
        },
      });

      // Verify invitation token was deleted
      expect(deleteInvitationToken).toHaveBeenCalledWith(validInvitationData.email);

      // Verify sign-in was called to create session
      expect(vi.mocked(auth.api.signInEmail)).toHaveBeenCalledWith({
        body: {
          email: validInvitationData.email,
          password: validInvitationData.password,
        },
        asResponse: true,
      });

      // Verify session cookies were forwarded
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders).toHaveLength(2);
      expect(setCookieHeaders[0]).toContain('better-auth.session_token');
      expect(setCookieHeaders[1]).toContain('better-auth.csrf_token');
    });

    it('should set ADMIN role when invitation has ADMIN role', async () => {
      // Arrange: Invitation with ADMIN role
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-id',
        identifier: 'invitation:user@example.com',
        value: 'hashed-token',
        expiresAt: new Date('2024-12-31'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        metadata: {
          ...mockInvitationMetadata,
          role: 'ADMIN',
        },
      });

      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ['session-cookie'] },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert: User updated with ADMIN role
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: {
          emailVerified: true,
          role: 'ADMIN',
        },
      });
    });
  });

  describe('validation errors', () => {
    it('should return validation error for missing token', async () => {
      // Arrange: Request without token
      const invalidData = {
        email: 'user@example.com',
        password: 'SecurePass123!',
        confirmPassword: 'SecurePass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.details.errors).toBeDefined();
    });

    it('should return validation error for missing email', async () => {
      // Arrange
      const invalidData = {
        token: 'valid-token-123',
        password: 'SecurePass123!',
        confirmPassword: 'SecurePass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for invalid email format', async () => {
      // Arrange
      const invalidData = {
        token: 'valid-token-123',
        email: 'not-an-email',
        password: 'SecurePass123!',
        confirmPassword: 'SecurePass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for missing password', async () => {
      // Arrange
      const invalidData = {
        token: 'valid-token-123',
        email: 'user@example.com',
        confirmPassword: 'SecurePass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for weak password', async () => {
      // Arrange: Password too short
      const invalidData = {
        token: 'valid-token-123',
        email: 'user@example.com',
        password: 'weak',
        confirmPassword: 'weak',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for password without uppercase', async () => {
      // Arrange
      const invalidData = {
        token: 'valid-token-123',
        email: 'user@example.com',
        password: 'securepass123!',
        confirmPassword: 'securepass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for password confirmation mismatch', async () => {
      // Arrange: Passwords don't match
      const invalidData = {
        token: 'valid-token-123',
        email: 'user@example.com',
        password: 'SecurePass123!',
        confirmPassword: 'DifferentPass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.details.errors).toBeDefined();
      // Check that error is on confirmPassword field
      const errors = data.error.details.errors as Array<{ path: string; message: string }>;
      const confirmPasswordError = errors.find((e) => e.path === 'confirmPassword');
      expect(confirmPasswordError).toBeDefined();
      expect(confirmPasswordError?.message).toContain("Passwords don't match");
    });

    it('should return validation error for empty token', async () => {
      // Arrange
      const invalidData = {
        token: '',
        email: 'user@example.com',
        password: 'SecurePass123!',
        confirmPassword: 'SecurePass123!',
      };
      const request = createMockRequest(invalidData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return validation error for malformed JSON', async () => {
      // Arrange: Mock request.json() to throw SyntaxError
      const request = {
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      } as unknown as NextRequest;

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid JSON in request body');
    });
  });

  describe('invalid/expired invitation tokens', () => {
    it('should return error for invalid token', async () => {
      // Arrange: Mock token validation to fail
      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('Invalid or expired invitation token');

      // Verify we didn't proceed with user creation
      expect(vi.mocked(auth.api.signUpEmail)).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return error when invitation not found in database', async () => {
      // Arrange: Token is valid but invitation record not found
      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toContain('Invitation not found');
    });

    it('should return error when invitation has no metadata', async () => {
      // Arrange: Invitation exists but has no metadata
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-id',
        identifier: 'invitation:user@example.com',
        value: 'hashed-token',
        expiresAt: new Date('2024-12-31'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        metadata: null, // No metadata
      });

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toContain('Invitation not found');
    });
  });

  describe('better-auth signup failures', () => {
    it('should return error when signup fails', async () => {
      // Arrange: Mock better-auth signup to throw (auth.api throws on failure)
      vi.mocked(auth.api.signUpEmail).mockRejectedValue(new Error('Email already exists'));

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
      expect(data.error.message).toContain('Failed to create user account');

      // Verify we didn't update user or delete token
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(deleteInvitationToken).not.toHaveBeenCalled();
    });

    it('should handle signup failure without error message', async () => {
      // Arrange: Signup throws a generic error (no specific message)
      vi.mocked(auth.api.signUpEmail).mockRejectedValue(new Error('some error'));

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('Failed to create user account');
    });

    it.skip('should handle signup response with malformed user data', async () => {
      // Skipped: auth.api.signUpEmail always returns a typed result with user.id.
      // The scenario where user.id is undefined cannot happen with the direct API call pattern.
      // Previously tested HTTP response parsing which is no longer applicable.
    });
  });

  describe('better-auth sign-in failures', () => {
    it('should return error when sign-in fails after user creation', async () => {
      // Arrange: Signup succeeds, but sign-in response indicates failure
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: false,
        status: 401,
        headers: { getSetCookie: () => [] },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
      expect(data.error.message).toContain('User created but failed to create session');

      // Verify user was created and email verified
      expect(prisma.user.update).toHaveBeenCalled();
      expect(deleteInvitationToken).toHaveBeenCalled();
    });

    it('should handle sign-in failure without error message', async () => {
      // Arrange: Signup succeeds, sign-in returns non-ok status
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: false,
        status: 500,
        headers: { getSetCookie: () => [] },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('User created but failed to create session');
    });
  });

  describe('session cookie forwarding', () => {
    it('should forward Set-Cookie headers from sign-in response', async () => {
      // Arrange
      const sessionCookies = [
        'better-auth.session_token=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
        'better-auth.csrf_token=xyz789; Path=/; HttpOnly; Secure; SameSite=Lax',
      ];

      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => sessionCookies },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);

      // Assert: Response has Set-Cookie headers
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders).toHaveLength(2);
      expect(setCookieHeaders[0]).toBe(sessionCookies[0]);
      expect(setCookieHeaders[1]).toBe(sessionCookies[1]);
    });

    it('should handle sign-in response with no cookies', async () => {
      // Arrange: Sign-in succeeds but returns no cookies
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [] },
      } as any);

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should still succeed (cookies are optional)
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // No cookies forwarded
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders).toHaveLength(0);
    });
  });

  describe('database errors', () => {
    it('should handle database error when fetching invitation', async () => {
      // Arrange: Database throws error
      vi.mocked(prisma.verification.findFirst).mockRejectedValue(
        new Error('Database connection failed')
      );

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });

    it('should handle database error when updating user', async () => {
      // Arrange: Signup succeeds but user update fails
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(prisma.user.update).mockRejectedValue(new Error('Database write failed'));

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });

    it('should handle error when deleting invitation token', async () => {
      // Arrange: Token deletion fails
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [] },
      } as any);

      vi.mocked(deleteInvitationToken).mockRejectedValue(new Error('Delete failed'));

      const request = createMockRequest(validInvitationData);

      // Act
      const response = await POST(request);
      const data = await response.json();

      // Assert: Should still fail gracefully
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('logging', () => {
    it('should log invitation acceptance request', async () => {
      // Arrange: defaults in beforeEach provide working mocks
      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert: Logger was called
      expect(mockLogger.info).toHaveBeenCalledWith('Invitation acceptance requested', {
        email: validInvitationData.email,
      });
    });

    it('should log successful invitation acceptance', async () => {
      // Arrange: defaults in beforeEach provide working mocks
      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert: Check that important info logs were called during the flow
      // The route logs multiple events: request, metadata retrieved, user created, acceptance success
      expect(mockLogger.info).toHaveBeenCalled();

      // Check for specific log messages
      const logMessages = vi.mocked(mockLogger.info).mock.calls.map((call) => call[0]);
      expect(logMessages).toContain('Invitation acceptance requested');
      expect(logMessages).toContain('Invitation metadata retrieved');
      expect(logMessages).toContain('User created via better-auth');
    });

    it('should log error for invalid token', async () => {
      // Arrange
      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid invitation token', {
        email: validInvitationData.email,
      });
    });

    it('should log error on failure', async () => {
      // Arrange: Force an error
      vi.mocked(validateInvitationToken).mockRejectedValue(new Error('Unexpected error'));

      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to accept invitation',
        expect.any(Error)
      );
    });
  });

  describe('PII Reduction in Logging (Batch 5 Fix)', () => {
    it('should log only role from metadata, not full metadata object', async () => {
      // Arrange: defaults in beforeEach provide working mocks
      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert: Check the metadata retrieved log
      expect(mockLogger.info).toHaveBeenCalledWith('Invitation metadata retrieved', {
        email: validInvitationData.email,
        role: mockInvitationMetadata.role,
      });

      // Verify we didn't log the full metadata object (which contains name and invitedBy - PII)
      const metadataLogCall = vi
        .mocked(mockLogger.info)
        .mock.calls.find((call) => call[0] === 'Invitation metadata retrieved');
      expect(metadataLogCall).toBeDefined();
      const loggedData = metadataLogCall?.[1];

      // Should only have email and role
      expect(loggedData).toEqual({
        email: validInvitationData.email,
        role: mockInvitationMetadata.role,
      });

      // Should NOT have name or invitedBy
      expect(loggedData).not.toHaveProperty('name');
      expect(loggedData).not.toHaveProperty('invitedBy');
      expect(loggedData).not.toHaveProperty('invitedAt');
      expect(loggedData).not.toHaveProperty('metadata');
    });

    it('should not log PII fields from metadata (name, invitedBy)', async () => {
      // Arrange: Invitation with ADMIN role and full metadata
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-id',
        identifier: 'invitation:admin@example.com',
        value: 'hashed-token',
        expiresAt: new Date('2024-12-31'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        metadata: {
          name: 'Jane Admin',
          role: 'ADMIN',
          invitedBy: 'super-admin-id',
          invitedAt: '2024-01-01T00:00:00.000Z',
        },
      });

      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: { id: mockUserId },
        token: null,
      } as any);

      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [] },
      } as any);

      const requestData = {
        ...validInvitationData,
        email: 'admin@example.com',
      };
      const request = createMockRequest(requestData);

      // Act
      await POST(request);

      // Assert: Metadata log should only include role, not name or invitedBy
      const metadataLogCall = vi
        .mocked(mockLogger.info)
        .mock.calls.find((call) => call[0] === 'Invitation metadata retrieved');
      expect(metadataLogCall).toBeDefined();
      const loggedData = metadataLogCall?.[1];

      expect(loggedData).toEqual({
        email: 'admin@example.com',
        role: 'ADMIN',
      });

      // Ensure PII is not leaked
      expect(loggedData).not.toHaveProperty('name');
      expect(loggedData).not.toHaveProperty('invitedBy');
    });

    it('should handle USER role (default) without logging unnecessary data', async () => {
      // Arrange: defaults in beforeEach provide working mocks for USER role
      const request = createMockRequest(validInvitationData);

      // Act
      await POST(request);

      // Assert: USER role logged without extra metadata
      const metadataLogCall = vi
        .mocked(mockLogger.info)
        .mock.calls.find((call) => call[0] === 'Invitation metadata retrieved');
      expect(metadataLogCall?.[1]).toEqual({
        email: validInvitationData.email,
        role: 'USER',
      });
    });
  });
});
