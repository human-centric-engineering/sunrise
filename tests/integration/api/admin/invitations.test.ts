/**
 * Integration Test: Admin Invitations Endpoints
 *
 * Tests the admin invitation management endpoints:
 * - GET /api/v1/admin/invitations - List pending invitations
 * - DELETE /api/v1/admin/invitations/:email - Delete an invitation
 *
 * Test Coverage:
 * - Authentication and authorization (admin only)
 * - Query parameter validation (pagination, search, sorting)
 * - Invitation listing with inviter names
 * - Invitation deletion
 * - Error handling (not found, unauthorized, validation)
 *
 * @see app/api/v1/admin/invitations/route.ts
 * @see app/api/v1/admin/invitations/[email]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/admin/invitations/route';
import { DELETE } from '@/app/api/v1/admin/invitations/[email]/route';
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

// Mock getAllPendingInvitations utility
vi.mock('@/lib/utils/invitation-token', () => ({
  getAllPendingInvitations: vi.fn(),
  getValidInvitation: vi.fn(),
  deleteInvitationToken: vi.fn(),
}));

// Note: getRouteLogger is mocked globally in tests/setup.ts

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(() => new Headers()),
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import {
  getAllPendingInvitations,
  getValidInvitation,
  deleteInvitationToken,
} from '@/lib/utils/invitation-token';
import { getRouteLogger } from '@/lib/api/context';

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(queryParams?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/invitations');
  if (queryParams) {
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  return {
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
 * Test data factories
 */

const createMockInvitation = (
  email: string,
  name: string,
  role: string,
  invitedByName: string | null = 'Admin User'
) => ({
  email,
  name,
  role,
  invitedBy: 'admin-id-123',
  invitedByName,
  invitedAt: new Date('2025-01-15T10:00:00Z'),
  expiresAt: new Date('2025-01-22T10:00:00Z'), // 7 days later
});

/**
 * Response type interfaces
 */

interface SuccessListResponse {
  success: true;
  data: Array<{
    email: string;
    name: string;
    role: string;
    invitedBy: string;
    invitedByName: string | null;
    invitedAt: string;
    expiresAt: string;
  }>;
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface SuccessDeleteResponse {
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
 * Test Suite: GET /api/v1/admin/invitations
 */
describe('GET /api/v1/admin/invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful requests', () => {
    it('should return paginated list of invitations (admin user)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock invitations data
      const mockInvitations = [
        createMockInvitation('alice@example.com', 'Alice Johnson', 'USER'),
        createMockInvitation('bob@example.com', 'Bob Smith', 'USER'),
      ];

      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: mockInvitations,
        total: 2,
      });

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<SuccessListResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({
        email: 'alice@example.com',
        name: 'Alice Johnson',
        role: 'USER',
        invitedByName: 'Admin User',
      });
      expect(body.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('should use default pagination parameters', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);
      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: [],
        total: 0,
      });

      // Act
      const request = createMockRequest();
      await GET(request);

      // Assert: Should call with defaults (page 1, limit 20)
      expect(getAllPendingInvitations).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 20,
        sortBy: 'invitedAt',
        sortOrder: 'desc',
      });
    });

    it('should accept custom pagination parameters', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);
      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: [],
        total: 0,
      });

      // Act
      const request = createMockRequest({ page: '2', limit: '50' });
      await GET(request);

      // Assert
      expect(getAllPendingInvitations).toHaveBeenCalledWith({
        search: undefined,
        page: 2,
        limit: 50,
        sortBy: 'invitedAt',
        sortOrder: 'desc',
      });
    });

    it('should accept search parameter', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      const mockInvitations = [createMockInvitation('alice@example.com', 'Alice Johnson', 'USER')];

      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: mockInvitations,
        total: 1,
      });

      // Act
      const request = createMockRequest({ search: 'alice' });
      const response = await GET(request);
      const body = await parseResponse<SuccessListResponse>(response);

      // Assert
      expect(getAllPendingInvitations).toHaveBeenCalledWith({
        search: 'alice',
        page: 1,
        limit: 20,
        sortBy: 'invitedAt',
        sortOrder: 'desc',
      });
      expect(body.data).toHaveLength(1);
    });

    it('should accept sort parameters', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);
      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: [],
        total: 0,
      });

      // Act
      const request = createMockRequest({ sortBy: 'email', sortOrder: 'asc' });
      await GET(request);

      // Assert
      expect(getAllPendingInvitations).toHaveBeenCalledWith({
        search: undefined,
        page: 1,
        limit: 20,
        sortBy: 'email',
        sortOrder: 'asc',
      });
    });

    it('should handle empty invitations list', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);
      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: [],
        total: 0,
      });

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<SuccessListResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });

    it('should handle invitations with null invitedByName', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      const mockInvitations = [
        createMockInvitation('alice@example.com', 'Alice Johnson', 'USER', null), // Deleted inviter
      ];

      vi.mocked(getAllPendingInvitations).mockResolvedValue({
        invitations: mockInvitations,
        total: 1,
      });

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<SuccessListResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.data[0].invitedByName).toBeNull();
    });
  });

  describe('authorization', () => {
    it('should return 401 when not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(getAllPendingInvitations).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', async () => {
      // Arrange
      const userSession = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(userSession as never);

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Admin access required');
      expect(getAllPendingInvitations).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should reject invalid page parameter', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act
      const request = createMockRequest({ page: '0' }); // Page must be >= 1
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid limit parameter', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act
      const request = createMockRequest({ limit: '101' }); // Max limit is 100
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid sortBy parameter', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act
      const request = createMockRequest({ sortBy: 'invalid' });
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid sortOrder parameter', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act
      const request = createMockRequest({ sortOrder: 'invalid' });
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject too long search query', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Act: Search query > 200 characters
      const longSearch = 'a'.repeat(201);
      const request = createMockRequest({ search: longSearch });
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);
      vi.mocked(getAllPendingInvitations).mockRejectedValue(
        new Error('Failed to fetch pending invitations')
      );

      // Act
      const request = createMockRequest();
      const response = await GET(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });
});

/**
 * Test Suite: DELETE /api/v1/admin/invitations/:email
 */
describe('DELETE /api/v1/admin/invitations/:email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to create route context with params
   */
  function createRouteContext(email: string) {
    return {
      params: Promise.resolve({ email }),
    };
  }

  describe('successful deletion', () => {
    it('should delete invitation by email (admin user)', async () => {
      // Arrange: Mock admin session
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock existing invitation
      vi.mocked(getValidInvitation).mockResolvedValue({
        email: 'alice@example.com',
        metadata: {
          name: 'Alice Johnson',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      vi.mocked(deleteInvitationToken).mockResolvedValue(undefined);

      // Act
      const request = createMockRequest();
      const context = createRouteContext('alice@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<SuccessDeleteResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Invitation for alice@example.com has been deleted');

      // Assert: Should check if invitation exists
      expect(getValidInvitation).toHaveBeenCalledWith('alice@example.com');

      // Assert: Should delete the invitation
      expect(deleteInvitationToken).toHaveBeenCalledWith('alice@example.com');

      // Assert: Should log deletion
      const mockLogger = await vi.mocked(getRouteLogger).mock.results[0]?.value;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Admin deleted invitation',
        expect.objectContaining({
          email: 'alice@example.com',
          deletedBy: adminSession.user.id,
          deletedByEmail: adminSession.user.email,
        })
      );
    });

    it('should decode URL-encoded email', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      vi.mocked(getValidInvitation).mockResolvedValue({
        email: 'user+test@example.com',
        metadata: {
          name: 'Test User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      vi.mocked(deleteInvitationToken).mockResolvedValue(undefined);

      // Act: Pass URL-encoded email
      const request = createMockRequest();
      const context = createRouteContext('user%2Btest%40example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<SuccessDeleteResponse>(response);

      // Assert: Should decode email correctly
      expect(response.status).toBe(200);
      expect(getValidInvitation).toHaveBeenCalledWith('user+test@example.com');
      expect(deleteInvitationToken).toHaveBeenCalledWith('user+test@example.com');
      expect(body.data.message).toContain('user+test@example.com');
    });
  });

  describe('authorization', () => {
    it('should return 401 when not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser() as never);

      // Act
      const request = createMockRequest();
      const context = createRouteContext('alice@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(getValidInvitation).not.toHaveBeenCalled();
      expect(deleteInvitationToken).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', async () => {
      // Arrange
      const userSession = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(userSession as never);

      // Act
      const request = createMockRequest();
      const context = createRouteContext('alice@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Admin access required');
      expect(getValidInvitation).not.toHaveBeenCalled();
      expect(deleteInvitationToken).not.toHaveBeenCalled();
    });
  });

  describe('error cases', () => {
    it('should return 404 when invitation not found', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock invitation not found
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Act
      const request = createMockRequest();
      const context = createRouteContext('nonexistent@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Invitation not found or already expired');

      // Assert: Should not attempt deletion
      expect(deleteInvitationToken).not.toHaveBeenCalled();
    });

    it('should return 404 when invitation has expired', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      // Mock expired invitation (getValidInvitation returns null for expired)
      vi.mocked(getValidInvitation).mockResolvedValue(null);

      // Act
      const request = createMockRequest();
      const context = createRouteContext('expired@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should handle deletion errors gracefully', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      vi.mocked(getValidInvitation).mockResolvedValue({
        email: 'alice@example.com',
        metadata: {
          name: 'Alice',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      // Mock deletion error
      vi.mocked(deleteInvitationToken).mockRejectedValue(
        new Error('Failed to delete invitation token')
      );

      // Act
      const request = createMockRequest();
      const context = createRouteContext('alice@example.com');
      const response = await DELETE(request, context);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in email', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession as never);

      const specialEmail = 'user.name+tag@sub-domain.co.uk';
      vi.mocked(getValidInvitation).mockResolvedValue({
        email: specialEmail,
        metadata: {
          name: 'Test User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      vi.mocked(deleteInvitationToken).mockResolvedValue(undefined);

      // Act
      const request = createMockRequest();
      const context = createRouteContext(encodeURIComponent(specialEmail));
      const response = await DELETE(request, context);
      await parseResponse<SuccessDeleteResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(getValidInvitation).toHaveBeenCalledWith(specialEmail);
      expect(deleteInvitationToken).toHaveBeenCalledWith(specialEmail);
    });
  });
});
