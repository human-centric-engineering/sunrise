/**
 * Integration Test: Invitation Metadata Endpoint
 *
 * Tests the GET /api/v1/invitations/metadata endpoint for retrieving invitation metadata.
 *
 * Test Coverage:
 * GET /api/v1/invitations/metadata:
 * - Success scenarios (valid token with different roles)
 * - Invalid token scenarios (wrong token, returns 400)
 * - Expired token scenarios (token past expiration, returns 400)
 * - Missing invitation scenarios (invitation not found, returns 404)
 * - Query parameter validation (missing/invalid token, missing/invalid email)
 * - Edge cases (no metadata in invitation record)
 *
 * @see app/api/v1/invitations/metadata/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/invitations/metadata/route';
import type { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';

/**
 * Mock dependencies
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findFirst: vi.fn(),
    },
  },
}));

// Mock invitation token validation
vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
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

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { validateInvitationToken } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';

/**
 * Response type interfaces
 */
interface SuccessResponse {
  success: true;
  data: {
    name: string;
    role: string;
  };
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type APIResponse = SuccessResponse | ErrorResponse;

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(searchParams: Record<string, string | null>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/invitations/metadata');
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== null) {
      url.searchParams.set(key, value);
    }
  });

  return {
    url: url.toString(),
    headers: new Headers(),
  } as unknown as NextRequest;
}

/**
 * Helper function to parse JSON response
 */
async function parseResponse<T = APIResponse>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Helper function to create mock verification record
 */
function createMockVerification(
  email: string,
  metadata: { name: string; role: string }
): {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Prisma.JsonValue;
} {
  const now = new Date();
  return {
    id: 'verification_123',
    identifier: `invitation:${email}`,
    value: 'hashed_token_value',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    createdAt: now,
    updatedAt: now,
    metadata: metadata as Prisma.JsonValue,
  };
}

describe('GET /api/v1/invitations/metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Success Scenarios', () => {
    it('should return invitation metadata for valid token (USER role)', async () => {
      // Arrange
      const email = 'john@example.com';
      const token = 'valid_token_123';
      const metadata = { name: 'John Doe', role: 'USER' };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'John Doe',
        role: 'USER',
      });

      // Verify mocks were called correctly
      expect(validateInvitationToken).toHaveBeenCalledWith(email, token);
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: { identifier: `invitation:${email}` },
      });
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata requested', { email });
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata retrieved', { email });
    });

    it('should return invitation metadata for valid token (ADMIN role)', async () => {
      // Arrange
      const email = 'admin@example.com';
      const token = 'valid_admin_token';
      const metadata = { name: 'Admin User', role: 'ADMIN' };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'Admin User',
        role: 'ADMIN',
      });
    });

    it('should return invitation metadata for valid token (MODERATOR role)', async () => {
      // Arrange
      const email = 'mod@example.com';
      const token = 'valid_mod_token';
      const metadata = { name: 'Moderator User', role: 'MODERATOR' };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'Moderator User',
        role: 'MODERATOR',
      });
    });
  });

  describe('Invalid Token Scenarios', () => {
    it('should return 400 for invalid token', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'invalid_token';

      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid or expired invitation token');

      // Verify validateInvitationToken was called but findFirst was not
      expect(validateInvitationToken).toHaveBeenCalledWith(email, token);
      expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Invalid invitation token for metadata request', {
        email,
      });
    });

    it('should return 400 for wrong token (validation fails)', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'wrong_token_123';

      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid or expired invitation token');
    });
  });

  describe('Expired Token Scenarios', () => {
    it('should return 400 for expired token (validation fails due to expiration)', async () => {
      // Arrange
      const email = 'expired@example.com';
      const token = 'expired_token';

      // validateInvitationToken checks expiration and returns false
      vi.mocked(validateInvitationToken).mockResolvedValue(false);

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid or expired invitation token');

      expect(validateInvitationToken).toHaveBeenCalledWith(email, token);
      expect(logger.warn).toHaveBeenCalledWith('Invalid invitation token for metadata request', {
        email,
      });
    });
  });

  describe('Missing Invitation Scenarios', () => {
    it('should return 404 when invitation not found in database', async () => {
      // Arrange
      const email = 'notfound@example.com';
      const token = 'valid_token';

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(404);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('Invitation not found');

      expect(validateInvitationToken).toHaveBeenCalledWith(email, token);
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: { identifier: `invitation:${email}` },
      });
      expect(logger.warn).toHaveBeenCalledWith('Invitation not found', { email });
    });

    it('should return 404 when invitation has no metadata', async () => {
      // Arrange
      const email = 'nometadata@example.com';
      const token = 'valid_token';

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification_no_meta',
        identifier: `invitation:${email}`,
        value: 'hashed_token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null, // No metadata stored
      });

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(404);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('Invitation not found');

      expect(logger.warn).toHaveBeenCalledWith('Invitation not found', { email });
    });
  });

  describe('Query Parameter Validation', () => {
    it('should return 400 when token query parameter is missing', async () => {
      // Arrange
      const request = createMockRequest({ token: null, email: 'user@example.com' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');

      // Validation should fail before calling validateInvitationToken
      expect(validateInvitationToken).not.toHaveBeenCalled();
    });

    it('should return 400 when token is empty string', async () => {
      // Arrange
      const request = createMockRequest({ token: '', email: 'user@example.com' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
    });

    it('should return 400 when email query parameter is missing', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: null });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');

      expect(validateInvitationToken).not.toHaveBeenCalled();
    });

    it('should return 400 when email is empty string', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: '' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
    });

    it('should return 400 when email has invalid format', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: 'not-an-email' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');

      expect(validateInvitationToken).not.toHaveBeenCalled();
    });

    it('should return 400 when email is missing @ symbol', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: 'userexample.com' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when both token and email are missing', async () => {
      // Arrange
      const request = createMockRequest({ token: null, email: null });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
    });
  });

  describe('Edge Cases', () => {
    it('should handle metadata with additional fields (ignores extra fields)', async () => {
      // Arrange
      const email = 'extra@example.com';
      const token = 'valid_token';
      const metadata = {
        name: 'User with Extra Fields',
        role: 'USER',
        invitedBy: 'admin-id',
        invitedAt: '2025-01-01T00:00:00.000Z',
        extraField: 'should be ignored',
      };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      // Should only return name and role (ignores extra fields)
      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'User with Extra Fields',
        role: 'USER',
      });
      expect(data.data).not.toHaveProperty('invitedBy');
      expect(data.data).not.toHaveProperty('extraField');
    });

    it('should handle emails with special characters', async () => {
      // Arrange
      const email = 'user+test@example.com';
      const token = 'valid_token';
      const metadata = { name: 'User Plus', role: 'USER' };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'User Plus',
        role: 'USER',
      });
    });

    it('should handle very long tokens', async () => {
      // Arrange
      const email = 'longtoken@example.com';
      const token = 'a'.repeat(128); // Very long token (64 hex chars is normal)
      const metadata = { name: 'Long Token User', role: 'USER' };

      vi.mocked(validateInvitationToken).mockResolvedValue(true);
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(
        createMockVerification(email, metadata)
      );

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(validateInvitationToken).toHaveBeenCalledWith(email, token);
    });
  });
});
