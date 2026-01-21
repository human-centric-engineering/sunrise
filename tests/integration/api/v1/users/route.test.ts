/**
 * Integration Test: Users Management Endpoints
 *
 * Tests the GET /api/v1/users endpoint for user listing and management.
 *
 * Test Coverage:
 * GET /api/v1/users:
 * - Successful list (admin user)
 * - Pagination
 * - Search functionality
 * - Sorting
 * - Unauthorized (non-admin user)
 * - Unauthenticated (no session)
 *
 * Note: POST /api/v1/users has been removed. Use invitation flow instead:
 * - POST /api/v1/users/invite (admin creates invitation)
 * - POST /api/auth/accept-invite (user accepts and sets password)
 *
 * @see app/api/v1/users/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/users/route';
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
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    session: {
      delete: vi.fn(),
    },
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

/**
 * Helper function to create a mock NextRequest for GET
 */
function createMockGetRequest(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/users');
  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return {
    headers: new Headers(),
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

describe('GET /api/v1/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
        },
      });
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(403);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required',
        },
      });
    });
  });

  describe('Successful Retrieval', () => {
    it('should return paginated list of users for admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const mockUsers = [
        {
          id: 'user-1',
          name: 'John Doe',
          email: 'john@example.com',
          role: 'USER',
          emailVerified: false,
          image: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
          bio: null,
          phone: null,
          timezone: 'UTC',
          location: null,
          preferences: {},
        },
        {
          id: 'user-2',
          name: 'Jane Smith',
          email: 'jane@example.com',
          role: 'ADMIN',
          emailVerified: true,
          image: null,
          createdAt: new Date('2025-01-02'),
          updatedAt: new Date('2025-01-02'),
          bio: null,
          phone: null,
          timezone: 'UTC',
          location: null,
          preferences: {},
        },
      ];

      vi.mocked(prisma.user.findMany).mockResolvedValue(mockUsers);
      vi.mocked(prisma.user.count).mockResolvedValue(2);

      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{
        success: boolean;
        data: typeof mockUsers;
        meta: { page: number; limit: number; total: number; totalPages: number };
      }>(response);

      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.data[0]).toMatchObject({
        id: 'user-1',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'USER',
      });
      expect(data.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('should support pagination', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const mockUsers = [
        {
          id: 'user-3',
          name: 'User 3',
          email: 'user3@example.com',
          role: 'USER',
          emailVerified: false,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          bio: null,
          phone: null,
          timezone: 'UTC',
          location: null,
          preferences: {},
        },
      ];

      vi.mocked(prisma.user.findMany).mockResolvedValue(mockUsers);
      vi.mocked(prisma.user.count).mockResolvedValue(25);

      const request = createMockGetRequest({ page: '2', limit: '10' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 10,
        take: 10,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          emailVerified: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const data = await parseResponse<{ meta: { page: number; limit: number; total: number } }>(
        response
      );
      expect(data.meta).toMatchObject({
        page: 2,
        limit: 10,
        total: 25,
      });
    });

    it('should support search functionality', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      const request = createMockGetRequest({ search: 'john' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: 'john', mode: 'insensitive' } },
            { email: { contains: 'john', mode: 'insensitive' } },
          ],
        },
        skip: 0,
        take: 20,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          emailVerified: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should support sorting', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);
      vi.mocked(prisma.user.count).mockResolvedValue(0);

      const request = createMockGetRequest({ sortBy: 'email', sortOrder: 'asc' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          emailVerified: true,
          createdAt: true,
        },
        orderBy: { email: 'asc' },
      });
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid query parameters', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockGetRequest({ page: 'invalid' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
        },
      });
    });
  });
});
