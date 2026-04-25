/**
 * Unit Tests: DELETE /api/v1/users/[id] Route
 *
 * Tests the user deletion API route handler for DELETE requests.
 *
 * Test Coverage:
 * - Authentication (unauthenticated request)
 * - Authorization (non-admin user, admin user)
 * - Self-deletion prevention
 * - User existence validation
 * - Successful user deletion
 * - Avatar file cleanup (storage enabled/disabled)
 * - Error handling (invalid ID format, database errors)
 * - Response structure validation
 *
 * @see app/api/v1/users/[id]/route.ts (lines 208-258)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE } from '@/app/api/v1/users/[id]/route';
import type { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

/**
 * Mock dependencies
 */

// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock auth config
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
      delete: vi.fn(),
    },
  },
}));

// Mock route logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@/lib/api/context', async () => {
  return {
    getRouteLogger: vi.fn(async () => mockLogger),
  };
});

// Mock storage module
vi.mock('@/lib/storage/upload', () => ({
  deleteByPrefix: vi.fn(),
  isStorageEnabled: vi.fn(),
}));

// Import mocked modules
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { isStorageEnabled } from '@/lib/storage/upload';

/**
 * Response type interfaces
 */
interface DeleteSuccessResponse {
  success: true;
  data: {
    id: string;
    deleted: true;
  };
}

interface ErrorResponse {
  success: false;
  error: {
    code?: string;
    message: string;
    details?: unknown;
  };
}

type APIResponse = DeleteSuccessResponse | ErrorResponse;

/**
 * Helper function to parse JSON response
 */
async function parseResponse<T = APIResponse>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Helper function to create mock params
 */
function createMockParams(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

/**
 * Test Suite: DELETE /api/v1/users/[id]
 */
describe('DELETE /api/v1/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());

    // SOURCE DECISION: Document — S2
    // Default isStorageEnabled to false so tests that don't reach the storage branch
    // are not accidentally affected by a previous test's storage-on override.
    // Tests that need storage ON set vi.mocked(isStorageEnabled).mockReturnValue(true)
    // explicitly in their own arrange step.
    vi.mocked(isStorageEnabled).mockReturnValue(false);
  });

  describe('Authentication and Authorization', () => {
    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00003wsloputgwul'); // Valid CUID

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert — withAdminAuth returns 401 for missing session (not 403)
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');

      // Should not query database when not authenticated
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should return 403 when non-admin user tries to delete a user', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00004wsloputgwux'); // Different valid CUID

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // SOURCE DECISION: Document — withAdminAuth guard (guards.ts line 172) throws
      // ForbiddenError('Admin access required') for non-admin sessions. handleAPIError
      // converts that to { success: false, error: { code: 'FORBIDDEN', message: '...' } }.
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');

      // Should not query database when not authorized
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should allow admin to delete other users', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00005wsloputgwuy'; // Different valid CUID
      const mockUser = {
        id: targetUserId,
        name: 'Target User',
        email: 'target@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as disabled for this test
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<DeleteSuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(targetUserId);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.data.deleted).toBe(true);
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
    });
  });

  describe('Self-Deletion Prevention', () => {
    it('should return 400 when admin tries to delete themselves', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      const adminUserId = adminUser.user.id;
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(adminUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CANNOT_DELETE_SELF');
      expect(data.error.message).toBe('Cannot delete your own account');

      // Should not query database or delete when trying to self-delete
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('Admin Deletion Safeguard', () => {
    it('should return 400 when admin tries to delete another admin account', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetAdminId = 'cmjbv4i3x00020wsloputgwaa'; // Different admin user
      const mockTargetAdmin = {
        id: targetAdminId,
        name: 'Another Admin',
        email: 'admin2@example.com',
        role: 'ADMIN',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockTargetAdmin as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetAdminId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.message).toBe('Cannot delete an admin account. Demote the user first.');
      // Source L210 passes no `code:` to errorResponse — pin the no-code contract.
      expect(data.error.code).toBeUndefined();

      // Should check if user exists but not attempt deletion
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: targetAdminId },
      });
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('User Existence Validation', () => {
    it('should return 404 when target user does not exist', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00006wsloputgwuz'); // Valid but non-existent CUID

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('User not found');

      // Should check if user exists but not attempt deletion
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'cmjbv4i3x00006wsloputgwuz' },
      });
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('Successful User Deletion', () => {
    it('should successfully delete user and return correct response structure', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00007wsloputgwa0';
      const mockUser = {
        id: targetUserId,
        name: 'Delete Me',
        email: 'deleteme@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as disabled
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<DeleteSuccessResponse>(response);

      // Assert - Response structure
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.success).toBe(true);

      // Assert - Response data
      expect(data.data).toHaveProperty('id');
      expect(data.data).toHaveProperty('deleted');
      expect(data.data.id).toBe(targetUserId);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.data.deleted).toBe(true);

      // Assert - Database operations
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
    });

    it('should set correct Content-Type header', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00008wsloputgwa1';
      const mockUser = { id: targetUserId, name: 'User', email: 'user@example.com', role: 'USER' };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as disabled
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });

      // Assert
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should emit a structured log.info with deletedUserId and adminId after successful delete', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00031wsloputgwbd';
      const mockUser = {
        id: targetUserId,
        name: 'Log Test User',
        email: 'logtest@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });

      // Assert — status first, then structured log contract
      expect(response.status).toBe(200);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'User deleted by admin',
        expect.objectContaining({
          deletedUserId: targetUserId,
          adminId: adminUser.user.id,
        })
      );
    });
  });

  describe('Avatar File Cleanup', () => {
    it('should clean up avatar files when storage is enabled', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00009wsloputgwa2';
      const mockUser = {
        id: targetUserId,
        name: 'User With Avatar',
        email: 'avatar@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as enabled
      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(true);
      // test-review:accept mock-shape-drift — DeleteResult shape matches; prefix-as-key is valid
      // per lib/storage/upload.ts:218. Shape is consistent throughout this file.
      vi.mocked(deleteByPrefix).mockResolvedValue({
        success: true,
        key: `avatars/${targetUserId}/`,
      });

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<DeleteSuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.success).toBe(true);

      // Verify avatar cleanup was called
      // test-review:accept no_arg_called — isStorageEnabled is a boolean accessor with no arguments; presence check is the contract
      expect(isStorageEnabled).toHaveBeenCalled();
      expect(deleteByPrefix).toHaveBeenCalledWith(`avatars/${targetUserId}/`);

      // Verify user was deleted
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
    });

    it('should skip avatar cleanup when storage is disabled', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00010wsloputgwa3';
      const mockUser = {
        id: targetUserId,
        name: 'User Without Storage',
        email: 'nostorage@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as disabled
      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<DeleteSuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.success).toBe(true);

      // Verify storage check was called but cleanup was skipped
      // test-review:accept no_arg_called — isStorageEnabled is a boolean accessor with no arguments; presence check is the contract
      expect(isStorageEnabled).toHaveBeenCalled();
      expect(deleteByPrefix).not.toHaveBeenCalled();

      // Verify user was still deleted
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
    });

    it('should call deleteByPrefix BEFORE prisma.user.delete (storage-enabled ordering)', async () => {
      // Arrange — call order matters: avatar cleanup must precede row deletion so a storage
      // failure leaves orphan files rather than orphan DB rows
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00030wsloputgwbc';
      const mockUser = {
        id: targetUserId,
        name: 'Order Test User',
        email: 'order@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(deleteByPrefix).mockResolvedValue({
        success: true,
        key: `avatars/${targetUserId}/`,
      });

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });

      // Assert — status first, then call-order proof
      expect(response.status).toBe(200);
      const deleteByPrefixOrder = vi.mocked(deleteByPrefix).mock.invocationCallOrder[0];
      const prismaDeleteOrder = vi.mocked(prisma.user.delete).mock.invocationCallOrder[0];
      expect(deleteByPrefixOrder).toBeLessThan(prismaDeleteOrder);
      expect(deleteByPrefix).toHaveBeenCalledWith(`avatars/${targetUserId}/`);
    });

    it('should handle avatar cleanup errors gracefully', async () => {
      // SOURCE DECISION: tcm-verified — route.ts L216-224 has no try/catch around deleteByPrefix.
      // If deleteByPrefix rejects, the error propagates out of the handler and is caught by the
      // outer handleAPIError wrapper (which returns 500). Since prisma.user.delete is called
      // AFTER deleteByPrefix (L222-224), a storage rejection means delete is never reached.
      // This test correctly asserts 500 + no delete when storage cleanup fails.

      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00011wsloputgwa4';
      const mockUser = {
        id: targetUserId,
        name: 'User With Cleanup Error',
        email: 'cleanuperror@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      // Mock storage as enabled but cleanup fails
      const { isStorageEnabled, deleteByPrefix } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(true);
      vi.mocked(deleteByPrefix).mockRejectedValue(new Error('Storage cleanup failed'));

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert — status first (required pattern)
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');

      // Verify cleanup was attempted before the error propagated
      // test-review:accept no_arg_called — isStorageEnabled is a boolean accessor with no arguments; presence check is the contract
      expect(isStorageEnabled).toHaveBeenCalled();
      expect(deleteByPrefix).toHaveBeenCalledWith(`avatars/${targetUserId}/`);

      // User must not be deleted: storage error propagates before prisma.user.delete is reached
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it.each([
      ['', 'empty string'],
      ['invalid-id-format', 'malformed (non-CUID)'],
    ])('should return 400 VALIDATION_ERROR for invalid user ID (%s — %s)', async (invalidId) => {
      // Arrange — both inputs fail z.cuid() in userIdSchema; merged into one parameterised test
      // since the schema has a single CUID rule (no distinct emptiness vs format rule).
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(invalidId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');

      // Should not attempt database operations
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00012wsloputgwa5';
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');

      // Should not attempt deletion after findUnique fails
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('should handle deletion errors gracefully', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00013wsloputgwa6';
      const mockUser = {
        id: targetUserId,
        name: 'User',
        email: 'user@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockRejectedValue(new Error('Foreign key constraint failed'));

      // Mock storage as disabled
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('Response Structure Validation', () => {
    it('should return standardized success response structure', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00014wsloputgwa7';
      const mockUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUser as any);

      // Mock storage as disabled
      const { isStorageEnabled } = await import('@/lib/storage/upload');
      vi.mocked(isStorageEnabled).mockReturnValue(false);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<DeleteSuccessResponse>(response);

      // Assert - Response structure
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.success).toBe(true);
      expect(typeof data.data).toBe('object');

      // Assert - Data structure
      expect(data.data).toHaveProperty('id');
      expect(data.data).toHaveProperty('deleted');
      expect(typeof data.data.id).toBe('string');
      // test-review:accept tobe_true — structural assertion on the API response envelope's success/deleted field, paired with status and data checks
      expect(data.data.deleted).toBe(true);
    });

    it('should return standardized error response structure', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00015wsloputgwa8');

      // Act
      const response = await DELETE(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert - Error response structure
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('error');
      expect(data.success).toBe(false);
      expect(typeof data.error).toBe('object');

      // Assert - Error object structure
      expect(data.error).toHaveProperty('code');
      expect(data.error).toHaveProperty('message');
      expect(typeof data.error.code).toBe('string');
      expect(typeof data.error.message).toBe('string');
    });
  });
});
