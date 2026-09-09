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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET, PATCH, DELETE } from '@/app/api/v1/users/[id]/route';
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

// Mock only the API-key RESOLVER; `hasScope` and the scope list stay real, since
// the credential narrowing this route now inherits is exactly what they decide.
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>();
  return { ...actual, resolveApiKey: vi.fn().mockResolvedValue(null) };
});

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Mock eraseUser — assert called, don't execute real erasure
vi.mock('@/lib/privacy/erase-user', () => ({
  eraseUser: vi.fn(),
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
import { eraseUser } from '@/lib/privacy/erase-user';
import { resolveApiKey } from '@/lib/auth/api-keys';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
  SAFE_MODE_POLICY,
} from '@/lib/auth/authorization';

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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      // 'Access denied', not 'Forbidden': the refusal now comes from the guard's
      // canRead call rather than an inline check in the handler. Status and code
      // are unchanged, which is the behaviour-neutrality that matters.
      expect(data.error.message).toBe('Access denied');

      // Should not query database when not authorized
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(userId);
      expect(data.data.name).toBe('John Doe');
      expect(data.data.email).toBe('john@example.com');
      expect(data.data.role).toBe('USER');
      // test-review:accept tobe_true — emailVerified is a boolean field on the user model; structural assertion against the DB-derived value
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.emailVerified).toBe(true);
      expect(data.data.image).toBe('https://example.com/avatar.jpg');

      // Assert - Extended profile fields (Phase 3.2)
      expect(data.data.bio).toBe('Full-stack developer passionate about TypeScript');
      expect(data.data.phone).toBe('+1-555-123-4567');
      expect(data.data.timezone).toBe('America/Los_Angeles');
      expect(data.data.location).toBe('San Francisco, CA');

      // Assert - Timestamp fields serialised to ISO strings by the route
      expect(data.data.createdAt).toBe(mockUser.createdAt.toISOString());
      expect(data.data.updatedAt).toBe(mockUser.updatedAt.toISOString());
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — emailVerified is a boolean field on the user model; structural assertion against the DB-derived value
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('New Name');
      expect(data.data.role).toBe('ADMIN');
      // test-review:accept tobe_true — emailVerified is a boolean field on the user model; structural assertion against the DB-derived value
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(prisma.user.update).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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

/**
 * Test Suite: DELETE /api/v1/users/[id]
 *
 * DELETE is wrapped with withAdminAuth. The existing file's guard-mock pattern
 * (mock @/lib/auth/config to expose auth.api.getSession as a vi.fn, mock
 * next/headers headers, set session via vi.mocked(auth.api.getSession)) is
 * reused here — no changes to the existing mocks are needed.
 *
 * eraseUser is mocked at the module level (see vi.mock('@/lib/privacy/erase-user')
 * above) so the real erasure pipeline never runs in these tests.
 */
describe('DELETE /api/v1/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers());
    // Default: admin caller for DELETE (withAdminAuth requires ADMIN role)
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Default: eraseUser resolves (no return value needed — route ignores it)
    vi.mocked(eraseUser).mockResolvedValue(undefined as any);
  });

  it('should return 400 CANNOT_DELETE_SELF when session.user.id matches the target id', async () => {
    // Arrange — admin tries to delete their own account
    const adminUser = mockAdminUser();
    const adminId = adminUser.user.id; // same ID used for both session and params
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

    const mockRequest = {} as NextRequest;
    const params = createMockParams(adminId);

    // Act
    const response = await DELETE(mockRequest, { params });
    const data = await parseResponse<ErrorResponse>(response);

    // Assert — self-delete guard fires before any DB access
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CANNOT_DELETE_SELF');

    // eraseUser must NOT have been called — self-delete is blocked before erasure
    expect(eraseUser).not.toHaveBeenCalled();
    // findUnique must NOT have been reached — self check precedes DB lookup
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: self-delete check fires before DB access
  });

  it('should return 400 with admin-delete message when target user has role ADMIN', async () => {
    // Arrange — admin tries to delete another admin account
    const adminUser = mockAdminUser();
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

    const targetUserId = 'cmjbv4i3x00020wsloputgwab';
    const targetUser = {
      id: targetUserId,
      name: 'Other Admin',
      email: 'otheradmin@example.com',
      role: 'ADMIN', // <- role that triggers the admin-delete guard
      emailVerified: true,
      image: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(targetUser as any);

    const mockRequest = {} as NextRequest;
    const params = createMockParams(targetUserId);

    // Act
    const response = await DELETE(mockRequest, { params });
    const data = await parseResponse<ErrorResponse>(response);

    // Assert — admin-target guard fires after findUnique, before eraseUser
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CANNOT_DELETE_ADMIN');
    expect(data.error.message).toBe('Cannot delete an admin account. Demote the user first.');

    // eraseUser must NOT have been called
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('should return 404 when target user does not exist', async () => {
    // Arrange — findUnique returns null (user not found)
    const adminUser = mockAdminUser();
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

    const nonExistentId = 'cmjbv4i3x00021wsloputgwac';
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const mockRequest = {} as NextRequest;
    const params = createMockParams(nonExistentId);

    // Act
    const response = await DELETE(mockRequest, { params });
    const data = await parseResponse<ErrorResponse>(response);

    // Assert — NotFoundError thrown and converted to 404 envelope
    expect(response.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('NOT_FOUND');

    // eraseUser must NOT have been called — user didn't exist
    expect(eraseUser).not.toHaveBeenCalled();
  });

  it('should call eraseUser with the correct arguments and return 200 { id, deleted: true } for a USER target', async () => {
    // Arrange — admin deletes a regular USER target
    const adminUser = mockAdminUser();
    const adminId = adminUser.user.id;
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

    const targetUserId = 'cmjbv4i3x00022wsloputgwad';
    const targetUser = {
      id: targetUserId,
      name: 'Regular User',
      email: 'regular@example.com',
      role: 'USER',
      emailVerified: true,
      image: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue(targetUser as any);

    const mockRequest = {} as NextRequest;
    const params = createMockParams(targetUserId);

    // Act
    const response = await DELETE(mockRequest, { params });
    const data = await parseResponse<SuccessResponse>(response);

    // Assert — success envelope with the deleted user's id
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toMatchObject({ id: targetUserId, deleted: true });

    // Assert — eraseUser was called exactly once with the right contract arguments.
    // The route passes target email (not session email) and admin id as actorUserId.
    // This is the key behavioral proof: the handler passes the TARGET's email and
    // the ADMIN's id, not any echo of the mock's return value.
    expect(eraseUser).toHaveBeenCalledOnce();
    expect(eraseUser).toHaveBeenCalledWith({
      userId: targetUserId,
      userEmail: targetUser.email,
      actorUserId: adminId,
      reason: 'admin_action',
    });

    // Ported from route.delete.test.ts: the structured audit log names who deleted whom.
    expect(mockLogger.info).toHaveBeenCalledWith('User deleted by admin', {
      deletedUserId: targetUserId,
      adminId,
    });
  });

  it('returns 500 INTERNAL_ERROR when eraseUser rejects — the error propagates through the guard wrapper and the delete is not silently swallowed', async () => {
    // Arrange — admin deletes a valid USER target, but the erasure service fails
    const adminUser = mockAdminUser();
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);
    const targetUserId = 'cmjbv4i3x00033wsloputgwae';
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: targetUserId,
      name: 'Doomed User',
      email: 'doomed@example.com',
      role: 'USER',
    } as never);
    vi.mocked(eraseUser).mockRejectedValue(new Error('erase failed'));

    // Act
    const response = await DELETE({} as NextRequest, { params: createMockParams(targetUserId) });
    const data = await parseResponse<ErrorResponse>(response);

    // Assert — full error envelope at 500
    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INTERNAL_ERROR');
  });

  it('should hit CANNOT_DELETE_SELF before the role check when the caller is both self and an ADMIN account', async () => {
    // Arrange — the caller IS an ADMIN, and the target ID is their own ID.
    // If guard order were reversed (role first, then self), this test would return the
    // admin-target 400 instead of CANNOT_DELETE_SELF. The source L192 checks self FIRST.
    const adminUser = mockAdminUser();
    const adminId = adminUser.user.id;
    vi.mocked(auth.api.getSession).mockResolvedValue(adminUser);

    // Target is the admin's own id — so both self AND would-be admin-target conditions
    // could fire if the order were wrong. The source checks self first (L192-197),
    // so we never reach findUnique or the role check.
    const mockRequest = {} as NextRequest;
    const params = createMockParams(adminId);

    // Act
    const response = await DELETE(mockRequest, { params });
    const data = await parseResponse<ErrorResponse>(response);

    // Assert — CANNOT_DELETE_SELF wins because it is checked first
    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('CANNOT_DELETE_SELF');

    // Neither findUnique (role check prereq) nor eraseUser should be reached
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — guard-order proof: self check fires first, DB not reached
    expect(eraseUser).not.toHaveBeenCalled();
  });
});

/**
 * The point of t-675: this route's read decision is now the policy's.
 *
 * The tests above prove behaviour is unchanged under Sunrise's default —
 * self-read allowed, admin-reads-other allowed, non-admin-reads-other refused.
 * These prove the thing that was impossible before the migration: that a fork
 * replacing the policy actually changes what this route returns. Without them
 * this task would have shipped a refactor and called it a fix.
 */
describe('GET /api/v1/users/[id] — the read decision is the policy’s', () => {
  const OTHER_ID = 'cmjbv4i3x00004wsloputgwux';

  // This block sits outside the describe that owns the file's `vi.clearAllMocks()`,
  // so it needs its own — without it these tests inherit call counts from each
  // other, and "the DB was never reached" passes or fails on the previous test.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers());
    vi.mocked(resolveApiKey).mockResolvedValue(null);
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  it('lets a registered NARROWING policy refuse a read the default allows', async () => {
    // An admin reading someone else: allowed by DEFAULT_AUTHORIZATION_POLICY,
    // and the test above proves it. A fork's policy that scopes reads to the
    // reader must be able to override that, or the seam is decoration.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target) =>
        Promise.resolve(target.kind === 'subject' ? target.userId === viewer.userId : true),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET({} as NextRequest, { params: createMockParams(OTHER_ID) });

    expect(response.status).toBe(403);
    // The DB is never reached: the policy refuses before the handler runs.
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the refusal must precede the read
  });

  it('still lets that same narrowing policy read the reader’s own row', async () => {
    // The control for the test above. Without it, "the policy narrowed the
    // route" is indistinguishable from "the route is broken for everyone".
    const currentUser = mockAdminUser();
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target) =>
        Promise.resolve(target.kind === 'subject' ? target.userId === viewer.userId : true),
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(currentUser);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: currentUser.user.id,
      name: 'Self',
      email: 'self@example.com',
      role: 'ADMIN',
      emailVerified: true,
      image: null,
      bio: null,
      phone: null,
      timezone: null,
      location: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const response = await GET({} as NextRequest, {
      params: createMockParams(currentUser.user.id),
    });

    expect(response.status).toBe(200);
  });

  it('refuses every declared read in safe mode, including an admin’s', async () => {
    // Safe mode is what an install runs when a fork's registration throws. Its
    // promise — "every declared read narrows to the reader's own rows" — could
    // not bind this route while the decision was inline. Now it can.
    registerAuthorizationPolicy(SAFE_MODE_POLICY);
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET({} as NextRequest, { params: createMockParams(OTHER_ID) });

    expect(response.status).toBe(403);
  });

  it('judges an API key by its SCOPES, not by its owner’s role', async () => {
    // The security fix hiding inside this migration. The inline check read
    // `session.user.role`, and for an API-key caller that is the KEY OWNER's
    // role — so a `chat`-scoped key belonging to an admin could read every
    // user's profile through this route. `administersEverything` judges an
    // api-key principal by `hasScope(scopes, 'admin')` instead, which is the
    // credential narrowing #542 established for every other surface.
    const adminOwner = mockAdminUser();
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: adminOwner,
      scopes: ['chat'],
      rateLimitRpm: null,
    });

    const response = await GET({} as NextRequest, { params: createMockParams(OTHER_ID) });

    expect(response.status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the key must not reach the row
  });

  it('still admits an API key that actually holds the admin scope', async () => {
    // The control for the test above: it must fail on the missing scope, not on
    // "api-key callers are refused", which would pass the previous test for a
    // reason that has nothing to do with the fix.
    const adminOwner = mockAdminUser();
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: adminOwner,
      scopes: ['admin'],
      rateLimitRpm: null,
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: OTHER_ID,
      name: 'Other',
      email: 'other@example.com',
      role: 'USER',
      emailVerified: true,
      image: null,
      bio: null,
      phone: null,
      timezone: null,
      location: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const response = await GET({} as NextRequest, { params: createMockParams(OTHER_ID) });

    expect(response.status).toBe(200);
  });
});
