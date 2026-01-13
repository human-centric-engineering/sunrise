/**
 * Unit Tests: GET /api/v1/invitations/metadata Route
 *
 * Tests the invitation metadata API route handler in isolation with mocked dependencies.
 *
 * Test Coverage:
 * - Successful metadata retrieval (valid token and email)
 * - Validation errors (missing/invalid token, missing/invalid email)
 * - Error cases (invitation not found, expired invitation)
 * - Token/email mismatch
 * - Query parameter validation
 * - HTTP response format validation
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

/**
 * Test Suite: GET /api/v1/invitations/metadata
 */
describe('GET /api/v1/invitations/metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Successful metadata retrieval', () => {
    it('should return 200 with name and role for valid token', async () => {
      // Arrange
      const email = 'john@example.com';
      const token = 'valid_token_abc123';
      const metadata = { name: 'John Doe', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        name: 'John Doe',
        role: 'USER',
      });
    });

    it('should call getInvitationMetadata with correct parameters', async () => {
      // Arrange
      const email = 'test@example.com';
      const token = 'test_token_123';
      const metadata = { name: 'Test User', role: 'ADMIN' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
      expect(getInvitationMetadata).toHaveBeenCalledTimes(1);
    });

    it('should log metadata request and retrieval', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'User', role: 'MODERATOR' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata requested', { email });
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata retrieved', { email });
    });

    it('should return only name and role fields from metadata', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'Test User', role: 'USER' };
      const fullResult = createValidResult(metadata);

      vi.mocked(getInvitationMetadata).mockResolvedValue(fullResult);

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      // Should only include name and role, not invitedBy, invitedAt, or expiresAt
      expect(data.data).toEqual({
        name: 'Test User',
        role: 'USER',
      });
      expect(data.data).not.toHaveProperty('invitedBy');
      expect(data.data).not.toHaveProperty('invitedAt');
      expect(data.data).not.toHaveProperty('expiresAt');
    });

    it('should handle ADMIN role metadata', async () => {
      // Arrange
      const email = 'admin@example.com';
      const token = 'admin_token';
      const metadata = { name: 'Admin User', role: 'ADMIN' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.role).toBe('ADMIN');
    });

    it('should handle MODERATOR role metadata', async () => {
      // Arrange
      const email = 'mod@example.com';
      const token = 'mod_token';
      const metadata = { name: 'Moderator User', role: 'MODERATOR' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.role).toBe('MODERATOR');
    });
  });

  describe('Validation errors - missing query parameters', () => {
    it('should return 400 when token is missing', async () => {
      // Arrange
      const request = createMockRequest({ token: null, email: 'user@example.com' });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');

      // Should not call getInvitationMetadata when validation fails
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });

    it('should return 400 when token is empty string', async () => {
      // Arrange
      const request = createMockRequest({ token: '', email: 'user@example.com' });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });

    it('should return 400 when email is missing', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: null });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
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
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });

    it('should return 400 when both token and email are missing', async () => {
      // Arrange
      const request = createMockRequest({ token: null, email: null });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid query parameters');
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });
  });

  describe('Validation errors - invalid email format', () => {
    it('should return 400 when email has invalid format', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: 'not-an-email' });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
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
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });

    it('should return 400 when email is just @ symbol', async () => {
      // Arrange
      const request = createMockRequest({ token: 'valid_token', email: '@' });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(getInvitationMetadata).not.toHaveBeenCalled();
    });

    it('should accept email with valid special characters (+, .)', async () => {
      // Arrange
      const email = 'user+test@example.co.uk';
      const token = 'valid_token';
      const metadata = { name: 'Test User', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
    });
  });

  describe('Error cases - invitation not found', () => {
    it('should return 404 when invitation does not exist', async () => {
      // Arrange
      const email = 'notfound@example.com';
      const token = 'nonexistent_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('not_found'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('Invitation not found');
    });

    it('should log warning when invitation not found', async () => {
      // Arrange
      const email = 'notfound@example.com';
      const token = 'nonexistent_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('not_found'));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation not found for metadata request', {
        email,
      });
    });

    it('should call getInvitationMetadata before returning 404', async () => {
      // Arrange
      const email = 'notfound@example.com';
      const token = 'nonexistent_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('not_found'));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
    });
  });

  describe('Error cases - expired invitation', () => {
    it('should return 410 when invitation has expired', async () => {
      // Arrange
      const email = 'expired@example.com';
      const token = 'expired_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('expired'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(410); // Gone - resource existed but is no longer available
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVITATION_EXPIRED');
      expect(data.error.message).toBe('This invitation has expired');
    });

    it('should log warning when invitation is expired', async () => {
      // Arrange
      const email = 'expired@example.com';
      const token = 'expired_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('expired'));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Expired invitation for metadata request', {
        email,
      });
    });
  });

  describe('Error cases - invalid token', () => {
    it('should return 400 when token does not match', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'wrong_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('Invalid invitation token');
    });

    it('should log warning when token is invalid', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'invalid_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invalid token for metadata request', {
        email,
      });
    });

    it('should call getInvitationMetadata even with invalid token', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'invalid_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      await GET(request);

      // Assert
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
    });
  });

  describe('Edge cases', () => {
    it('should handle very long tokens', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'a'.repeat(256); // Very long token
      const metadata = { name: 'User', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      expect(getInvitationMetadata).toHaveBeenCalledWith(email, token);
    });

    it('should handle names with special characters', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: "O'Brien-Smith (Jr.)", role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.name).toBe("O'Brien-Smith (Jr.)");
    });

    it('should handle unicode characters in names', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'José García-Müller', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.name).toBe('José García-Müller');
    });

    it('should set correct Content-Type header', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'User', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });
  });

  describe('Response structure validation', () => {
    it('should return standardized success response structure', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'Test User', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      expect(data.success).toBe(true);
      expect(typeof data.data).toBe('object');
    });

    it('should return standardized error response structure', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'invalid_token';

      vi.mocked(getInvitationMetadata).mockResolvedValue(createInvalidResult('invalid_token'));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('error');
      expect(data.success).toBe(false);
      expect(data.error).toHaveProperty('code');
      expect(data.error).toHaveProperty('message');
    });

    it('should not include meta field in success response', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = 'valid_token';
      const metadata = { name: 'Test User', role: 'USER' };

      vi.mocked(getInvitationMetadata).mockResolvedValue(createValidResult(metadata));

      const request = createMockRequest({ token, email });

      // Act
      const response = await GET(request);
      const data = await parseResponse(response);

      // Assert
      expect(data).not.toHaveProperty('meta');
    });

    it('should not include details field in validation error', async () => {
      // Arrange
      const request = createMockRequest({ token: null, email: 'user@example.com' });

      // Act
      const response = await GET(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(data.error).not.toHaveProperty('details');
    });
  });
});
