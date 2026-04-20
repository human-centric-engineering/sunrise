/**
 * Unit Tests: /api/v1/users/[id] Route
 *
 * Tests the user by ID API route handlers for GET and PATCH requests.
 *
 * GET Test Coverage:
 * - Authentication (unauthenticated request, authenticated user, admin user)
 * - Authorization (users can view own profile, admins can view any profile)
 * - Successful user retrieval with all fields including extended profile fields
 * - Error handling (user not found, invalid ID format)
 * - Response structure validation
 * - Extended profile fields (bio, phone, timezone, location) - Phase 3.2
 *
 * PATCH Test Coverage:
 * - Authentication (unauthenticated request)
 * - Authorization (admin only)
 * - Successful updates (name, role, emailVerified, multiple fields)
 * - Self-role change prevention (admin cannot demote themselves)
 * - Error handling (user not found, empty body, invalid body, invalid ID, database errors)
 * - Logging of admin updates
 *
 * @see app/api/v1/users/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PATCH } from '@/app/api/v1/users/[id]/route';
import type { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { createMockRequest } from '@/tests/helpers/api';

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
      update: vi.fn(),
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

// Import mocked modules
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

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
    image: string | null;
    bio: string | null;
    phone: string | null;
    timezone: string | null;
    location: string | null;
    createdAt: Date;
    updatedAt: Date;
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
 * Test Suite: GET /api/v1/users/[id]
 */
describe('GET /api/v1/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  describe('Authentication and Authorization', () => {
    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00003wsloputgwul'); // Valid CUID

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Unauthorized');

      // Should not query database when not authenticated
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should return 403 when non-admin user tries to view another user', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
      const mockRequest = {} as NextRequest;
      const params = createMockParams('cmjbv4i3x00004wsloputgwux'); // Different valid CUID

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Forbidden');

      // Should not query database when not authorized
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should allow user to view their own profile', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);

      const mockUser = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: 'Software engineer',
        phone: '+1234567890',
        timezone: 'America/New_York',
        location: 'New York, USA',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-15'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(userId);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          bio: true,
          phone: true,
          timezone: true,
          location: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should allow admin to view any user profile', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const targetUserId = 'cmjbv4i3x00005wsloputgwuy'; // Different valid CUID
      const mockUser = {
        id: targetUserId,
        name: 'Other User',
        email: 'other@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        bio: null,
        phone: null,
        timezone: 'UTC',
        location: null,
        createdAt: new Date('2025-01-10'),
        updatedAt: new Date('2025-01-10'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(targetUserId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(targetUserId);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: targetUserId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          bio: true,
          phone: true,
          timezone: true,
          location: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should return 404 when admin fetches a non-existent user', async () => {
      // Arrange — admin session fetching a different user's ID, but that user doesn't exist.
      // This covers the admin-then-404 path (source L50: role=ADMIN bypasses ForbiddenError,
      // source L74: findUnique returns null → NotFoundError).
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const nonExistentId = 'cmjbv4i3x00005wsloputgwuy'; // Valid CUID, different from admin
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(nonExistentId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('User not found');

      // Admin bypassed the 403 gate — DB WAS queried
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: nonExistentId },
        select: expect.objectContaining({ id: true, email: true }),
      });
    });
  });

  describe('Successful User Retrieval', () => {
    beforeEach(() => {
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
    });

    it('should return user with all fields including extended profile fields', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
        emailVerified: true,
        image: 'https://example.com/avatar.jpg',
        bio: 'Full-stack developer passionate about TypeScript',
        phone: '+1-555-123-4567',
        timezone: 'America/Los_Angeles',
        location: 'San Francisco, CA',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-15T12:30:00Z'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert - Standard fields
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(userId);
      expect(data.data.name).toBe('John Doe');
      expect(data.data.email).toBe('john@example.com');
      expect(data.data.role).toBe('USER');
      expect(data.data.emailVerified).toBe(true);
      expect(data.data.image).toBe('https://example.com/avatar.jpg');

      // Assert - Extended profile fields (Phase 3.2)
      expect(data.data.bio).toBe('Full-stack developer passionate about TypeScript');
      expect(data.data.phone).toBe('+1-555-123-4567');
      expect(data.data.timezone).toBe('America/Los_Angeles');
      expect(data.data.location).toBe('San Francisco, CA');

      // Assert - Timestamp fields
      expect(data.data.createdAt).toBeDefined();
      expect(data.data.updatedAt).toBeDefined();
    });

    it('should return user with null extended profile fields when not set', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Jane Smith',
        email: 'jane@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        bio: null,
        phone: null,
        timezone: null,
        location: null,
        createdAt: new Date('2025-01-20'),
        updatedAt: new Date('2025-01-20'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.bio).toBeNull();
      expect(data.data.phone).toBeNull();
      expect(data.data.timezone).toBeNull();
      expect(data.data.location).toBeNull();
    });

    it('should return user with default timezone when set', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: null,
        phone: null,
        timezone: 'UTC', // Default value
        location: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.timezone).toBe('UTC');
    });

    it('should return user with international timezone', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'International User',
        email: 'international@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: 'Working remotely from Tokyo',
        phone: '+81-90-1234-5678',
        timezone: 'Asia/Tokyo',
        location: 'Tokyo, Japan',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-25'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.timezone).toBe('Asia/Tokyo');
      expect(data.data.location).toBe('Tokyo, Japan');
      expect(data.data.phone).toBe('+81-90-1234-5678');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
    });

    it('should return 404 when user does not exist', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('User not found');
    });

    it('should return 400 for invalid user ID format', async () => {
      // Arrange
      const currentUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(''); // Empty ID

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for non-empty but malformed user ID format', async () => {
      // Arrange — 'not-a-cuid' is non-empty so it hits the CUID format rule,
      // exercising a different Zod rejection path than the empty-string test above.
      const currentUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);

      const mockRequest = {} as NextRequest;
      const params = createMockParams('not-a-cuid');

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      // ID validation fires before DB access
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('Response Structure Validation', () => {
    beforeEach(() => {
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
    });

    it('should return standardized success response structure', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: 'Test bio',
        phone: '+1234567890',
        timezone: 'UTC',
        location: 'Test Location',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      expect(data.success).toBe(true);
      expect(typeof data.data).toBe('object');
    });

    it('should include all required user fields in response', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Complete User',
        email: 'complete@example.com',
        role: 'USER', // Matches the USER session context — session.user.id === userId (self-access)
        emailVerified: true,
        image: 'https://example.com/image.jpg',
        bio: 'Complete profile',
        phone: '+1234567890',
        timezone: 'America/New_York',
        location: 'New York',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert - Standard fields
      expect(data.data).toHaveProperty('id');
      expect(data.data).toHaveProperty('name');
      expect(data.data).toHaveProperty('email');
      expect(data.data).toHaveProperty('role');
      expect(data.data).toHaveProperty('emailVerified');
      expect(data.data).toHaveProperty('image');
      expect(data.data).toHaveProperty('createdAt');
      expect(data.data).toHaveProperty('updatedAt');

      // Assert - Extended profile fields
      expect(data.data).toHaveProperty('bio');
      expect(data.data).toHaveProperty('phone');
      expect(data.data).toHaveProperty('timezone');
      expect(data.data).toHaveProperty('location');
    });

    it('should have correct data types for all fields', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Type Check User',
        email: 'typecheck@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        bio: 'Bio text',
        phone: '+1234567890',
        timezone: 'UTC',
        location: 'Location text',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert - Data types
      expect(typeof data.data.id).toBe('string');
      expect(typeof data.data.name).toBe('string');
      expect(typeof data.data.email).toBe('string');
      expect(typeof data.data.role).toBe('string');
      expect(typeof data.data.emailVerified).toBe('boolean');
      expect(['string', 'object']).toContain(typeof data.data.image); // null or string
      expect(['string', 'object']).toContain(typeof data.data.bio); // null or string
      expect(['string', 'object']).toContain(typeof data.data.phone); // null or string
      expect(['string', 'object']).toContain(typeof data.data.timezone); // null or string
      expect(['string', 'object']).toContain(typeof data.data.location); // null or string
    });

    it('should set correct Content-Type header', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: null,
        phone: null,
        timezone: 'UTC',
        location: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });

      // Assert
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should not include meta field in success response', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      const userId = currentUser.user.id;

      const mockUser = {
        id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        bio: null,
        phone: null,
        timezone: 'UTC',
        location: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);

      const mockRequest = {} as NextRequest;
      const params = createMockParams(userId);

      // Act
      const response = await GET(mockRequest, { params });
      const data = await parseResponse(response);

      // Assert
      expect(data).not.toHaveProperty('meta');
    });
  });
});

/**
 * Test Suite: PATCH /api/v1/users/[id]
 */
describe('PATCH /api/v1/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  describe('Authentication and Authorization', () => {
    it('should return 401 for unauthenticated request', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams('cmjbv4i3x00003wsloputgwul');

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Unauthorized');

      // Should not query database when not authenticated
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return 403 for non-admin user', async () => {
      // Arrange
      const currentUser = mockAuthenticatedUser('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams('cmjbv4i3x00003wsloputgwul');

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');

      // Should not query database when not authorized
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('Successful User Updates', () => {
    beforeEach(() => {
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);
    });

    it('should successfully update user name', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      const targetUserId = 'cmjbv4i3x00005wsloputgwuy';

      const existingUser = {
        id: targetUserId,
        name: 'Old Name',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        bio: null,
        phone: null,
        timezone: 'UTC',
        location: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'New Name',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('New Name');
      expect(data.data.id).toBe(targetUserId);

      // Verify database calls
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: targetUserId },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: { name: 'New Name' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith('User updated by admin', {
        userId: targetUserId,
        adminId: adminUser.user.id,
        changes: { name: 'New Name' },
      });
    });

    it('should successfully update user role', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00006wsloputgwuz';

      const existingUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { role: 'ADMIN' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.role).toBe('ADMIN');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: { role: 'ADMIN' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should successfully update emailVerified', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00007wsloputgwu0';

      const existingUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { emailVerified: true },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.emailVerified).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: { emailVerified: true },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should successfully set emailVerified to false and write only that field', async () => {
      // Arrange — mirror of the emailVerified:true test; verifies the false branch is symmetric
      // Source writes `...(body.emailVerified !== undefined && { emailVerified: body.emailVerified })`
      // so false is a valid truthy spread (the condition is !== undefined, not !!body.emailVerified).
      // No companion field (emailVerifiedAt) is cleared — confirmed by reading route.ts:133-150.
      const targetUserId = 'cmjbv4i3x00009wsloputgwu9';

      const existingUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { emailVerified: false },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert — handler must return 200 envelope with emailVerified:false
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.emailVerified).toBe(false);

      // Assert — prisma.user.update was called with ONLY emailVerified:false in data
      // (no companion field like emailVerifiedAt should appear — source has no such field)
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: { emailVerified: false },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should successfully update multiple fields at once', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00008wsloputgwu1';

      const existingUser = {
        id: targetUserId,
        name: 'Old Name',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'New Name',
        email: 'user@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: {
          name: 'New Name',
          role: 'ADMIN',
          emailVerified: true,
        },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('New Name');
      expect(data.data.role).toBe('ADMIN');
      expect(data.data.emailVerified).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: {
          name: 'New Name',
          role: 'ADMIN',
          emailVerified: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          emailVerified: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });
  });

  describe('Conditional field spread', () => {
    it('should NOT forward role or emailVerified to prisma.user.update when only name is provided', async () => {
      // Arrange — body contains ONLY name; proves the conditional spread doesn't forward absent fields
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);
      const targetUserId = 'cmjbv4i3x00030wsloputgwab';

      const existingUser = {
        id: targetUserId,
        name: 'Old Name',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: targetUserId,
        name: 'Name Only',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: false,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'Name Only' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });

      // Assert — status first, then the contract: absent fields must NOT appear in data
      expect(response.status).toBe(200);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ role: expect.anything() }),
        })
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ emailVerified: expect.anything() }),
        })
      );
    });

    it('should permit ADMIN to update own name without triggering the self-role-change guard', async () => {
      // Arrange — admin editing SELF with body that has only name (no role key)
      // The guard at source L125 only trips when body.role is present and !== 'ADMIN'
      const adminUser = mockAdminUser();
      const adminId = adminUser.user.id;
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const existingUser = {
        id: adminId,
        name: 'Admin Old',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        id: adminId,
        name: 'Admin New',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'Admin New' },
      });
      const params = createMockParams(adminId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert — 200: self-role-change guard did NOT fire; update proceeded
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('Self-Role Change Prevention', () => {
    it('should return 200 when admin sets own role to ADMIN (guard only fires for non-ADMIN role)', async () => {
      // Arrange — source L125: guard fires only when `body.role && body.role !== 'ADMIN'`.
      // Sending body={role:'ADMIN'} on self does NOT trigger the guard, so the update proceeds.
      const adminUser = mockAdminUser();
      const adminId = adminUser.user.id;
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const existingUser = {
        id: adminId,
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const updatedUser = {
        ...existingUser,
        updatedAt: new Date('2025-01-31'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { role: 'ADMIN' }, // Same role as current — guard condition NOT met
      });
      const params = createMockParams(adminId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<SuccessResponse>(response);

      // Assert — guard did NOT fire; update proceeded and returned 200
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'ADMIN' }),
        })
      );
    });

    it('should return 400 with SELF_ROLE_CHANGE when admin tries to change own role', async () => {
      // Arrange
      const adminUser = mockAdminUser();
      const adminId = adminUser.user.id;
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

      const existingUser = {
        id: adminId,
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'ADMIN',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { role: 'USER' },
      });
      const params = createMockParams(adminId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('SELF_ROLE_CHANGE');
      expect(data.error.message).toBe('Cannot change your own role');

      // Should not update user
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      const adminUser = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);
    });

    it('should return 404 when target user does not exist', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00009wsloputgwu2';
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
      expect(data.error.message).toBe('User not found');

      // Should not update user
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return validation error for empty body', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00010wsloputgwu3';

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: {},
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBe('At least one field must be provided');

      // Empty-body guard at route.ts:111 fires before the findUnique existence check —
      // findUnique is never reached.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return validation error for invalid body', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00011wsloputgwu4';

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { role: 'INVALID_ROLE' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');

      // Should not query database
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid user ID format', async () => {
      // Arrange
      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams(''); // Empty ID

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');

      // Should not query database
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const targetUserId = 'cmjbv4i3x00012wsloputgwu5';
      vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database connection failed'));

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');

      // Should not update user
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should return 500 when prisma.user.update rejects after a successful findUnique', async () => {
      // Arrange — findUnique succeeds (user exists), then update throws a DB error.
      // This exercises the catch path in withAdminAuth that wraps the update call,
      // distinct from the findUnique rejection test above which never reaches update.
      const targetUserId = 'cmjbv4i3x00013wsloputgwu6';
      const existingUser = {
        id: targetUserId,
        name: 'Test User',
        email: 'user@example.com',
        role: 'USER',
        emailVerified: true,
        image: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue(existingUser as any);
      vi.mocked(prisma.user.update).mockRejectedValue(new Error('DB fail'));

      const mockRequest = createMockRequest({
        method: 'PATCH',
        url: 'http://localhost:3000/api/v1/users/id',
        body: { name: 'New Name' },
      });
      const params = createMockParams(targetUserId);

      // Act
      const response = await PATCH(mockRequest, { params });
      const data = await parseResponse<ErrorResponse>(response);

      // Assert — the handler returns the generic 500 error envelope
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');

      // Assert — prisma.user.update WAS attempted (unlike the findUnique rejection path)
      expect(prisma.user.update).toHaveBeenCalledTimes(1);

      // Note: handleAPIError logs via the global logger from @/lib/logging (not mocked in this
      // test file) — asserting mockLogger.error would fail because the route's log.info
      // ('User updated by admin') is never reached when update throws. The key behavioral
      // contract is the 500 envelope and that update was attempted (verified above).
    });
  });
});
