/**
 * Integration Test: Invitation Metadata Endpoint
 *
 * Tests the GET /api/v1/invitations/metadata endpoint for retrieving invitation metadata.
 *
 * Test Coverage:
 * GET /api/v1/invitations/metadata:
 * - Success scenarios (valid token with different roles)
 * - Invalid token scenarios (wrong token, returns 400)
 * - Expired token scenarios (token past expiration, returns 410)
 * - Missing invitation scenarios (invitation not found, returns 404)
 * - Query parameter validation (missing/invalid token, missing/invalid email)
 * - Edge cases (long tokens, special characters in email)
 *
 * @see app/api/v1/invitations/metadata/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/invitations/metadata/route';
import type { NextRequest } from 'next/server';
import type { InvitationMetadataResult } from '@/lib/utils/invitation-token';

/**
 * Mock dependencies
 */

// Mock invitation token utilities
vi.mock('@/lib/utils/invitation-token', () => ({
  getInvitationMetadata: vi.fn(),
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
import { getInvitationMetadata } from '@/lib/utils/invitation-token';
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
 * Helper function to create a valid metadata result
 */
function createValidResult(metadata: { name: string; role: string }): InvitationMetadataResult {
  return {
    valid: true,
    metadata: {
      ...metadata,
      invitedBy: 'admin-user-id',
      invitedAt: new Date().toISOString(),
    },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

/**
 * Helper function to create an invalid metadata result
 */
function createInvalidResult(
  reason: 'expired' | 'invalid_token' | 'not_found'
): InvitationMetadataResult {
  return {
    valid: false,
    reason,
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

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

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
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata requested', { email });
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata retrieved', { email });
    });

    it('should return invitation metadata for valid token (ADMIN role)', async () => {
      // Arrange
      const email = 'admin@example.com';
      const token = 'valid_admin_token';
      const metadata = { name: 'Admin User', role: 'ADMIN' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

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

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

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

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid invitation token');

      // Verify getInvitationMetadata was called
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
      expect(logger.warn).toHaveBeenCalledWith('Invalid token for metadata request', {
        email,
      });
    });

    it('should return 400 for wrong token (validation fails)', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'wrong_token_123';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid invitation token');
    });
  });

  describe('Expired Token Scenarios', () => {
    it('should return 410 for expired token', async () => {
      // Arrange
      const email = 'expired@example.com';
      const token = 'expired_token';

      // getInvitationMetadata returns expired reason
      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('expired'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(410); // Gone - resource existed but is no longer available
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVITATION_EXPIRED');
      expect(data.error.message).toBe('This invitation has expired');

      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
      expect(logger.warn).toHaveBeenCalledWith('Expired invitation for metadata request', {
        email,
      });
    });
  });

  describe('Missing Invitation Scenarios', () => {
    it('should return 404 when invitation not found in database', async () => {
      // Arrange
      const email = 'notfound@example.com';
      const token = 'valid_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('not_found'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(404);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('Invitation not found');

      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
      expect(logger.warn).toHaveBeenCalledWith('Invitation not found for metadata request', {
        email,
      });
    });

    it('should return 404 when invitation has no metadata', async () => {
      // Arrange - getInvitationMetadata handles the case when metadata is missing
      // by returning not_found
      const email = 'nometadata@example.com';
      const token = 'valid_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('not_found'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(404);
      const data = await parseResponse<ErrorResponse>(response);

      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('Invitation not found');

      expect(logger.warn).toHaveBeenCalledWith('Invitation not found for metadata request', {
        email,
      });
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

      // Validation should fail before calling getInvitationMetadata
      expect(getInvitationMetadata).not.toHaveBeenCalled();
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

      expect(getInvitationMetadata).not.toHaveBeenCalled();
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

      expect(getInvitationMetadata).not.toHaveBeenCalled();
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
    it('should handle metadata with additional fields (only returns name and role)', async () => {
      // Arrange
      const email = 'extra@example.com';
      const token = 'valid_token';
      // getInvitationMetadata returns the full metadata, but the endpoint only returns name/role
      const metadata = { name: 'User with Extra Fields', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      // Should only return name and role
      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'User with Extra Fields',
        role: 'USER',
      });
    });

    it('should handle emails with special characters', async () => {
      // Arrange
      const email = 'user+test@example.com';
      const token = 'valid_token';
      const metadata = { name: 'User Plus', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

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

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<SuccessResponse>(response);

      expect(data.success).toBe(true);
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
    });
  });
});
