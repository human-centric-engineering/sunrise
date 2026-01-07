/**
 * Integration Test: Users Management Endpoints
 *
 * Tests the GET /api/v1/users and POST /api/v1/users endpoints for user management.
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
 * POST /api/v1/users:
 * - Successful user creation (admin user)
 * - Auto-generated password
 * - Custom role assignment
 * - Welcome email sent (non-blocking)
 * - Welcome email failure doesn't break user creation
 * - Duplicate email
 * - Unauthorized (non-admin user)
 * - Unauthenticated (no session)
 *
 * @see app/api/v1/users/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '@/app/api/v1/users/route';
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

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
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

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';

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
 * Helper function to create a mock NextRequest for POST
 */
function createMockPostRequest(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    nextUrl: {
      searchParams: new URLSearchParams(),
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
          role: true,
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
          role: true,
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
          role: true,
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

describe('POST /api/v1/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset fetch mock
    global.fetch = vi.fn();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
      });

      // Act
      const response = await POST(request);

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
      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
      });

      // Act
      const response = await POST(request);

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

  describe('Successful User Creation', () => {
    it('should create a user with provided password', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const mockSignupResponse = {
        user: {
          id: 'new-user-id',
          name: 'Test User',
          email: 'test@example.com',
          emailVerified: false,
          createdAt: new Date('2025-01-01').toISOString(),
        },
        session: {
          token: 'test-session-token',
          userId: 'new-user-id',
          expiresAt: new Date('2025-12-31').toISOString(),
        },
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockSignupResponse,
      } as Response);

      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'email-id' });
      vi.mocked(prisma.session.delete).mockResolvedValue({} as never);

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'SecurePassword123!',
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);
      const data = await parseResponse<{ success: boolean; data: { id: string; name: string } }>(
        response
      );

      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({
        id: 'new-user-id',
        name: 'Test User',
        email: 'test@example.com',
        role: 'USER',
        emailVerified: false,
      });

      // Verify better-auth signup was called
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/sign-up/email',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test User',
            email: 'test@example.com',
            password: 'SecurePassword123!',
          }),
        })
      );

      // Verify session was cleaned up
      expect(prisma.session.delete).toHaveBeenCalledWith({
        where: { token: 'test-session-token' },
      });
    });

    it('should create a user with auto-generated password', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const mockSignupResponse = {
        user: {
          id: 'new-user-id',
          name: 'Test User',
          email: 'test@example.com',
          emailVerified: false,
          createdAt: new Date('2025-01-01').toISOString(),
        },
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockSignupResponse,
      } as Response);

      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'email-id' });

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
        // No password provided
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);

      // Verify fetch was called with an auto-generated password (32 hex chars)
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/sign-up/email',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringMatching(/"password":"[a-f0-9]{32}"/),
        })
      );
    });

    it('should create a user with custom role', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const mockSignupResponse = {
        user: {
          id: 'new-admin-id',
          name: 'Admin User',
          email: 'admin@example.com',
          emailVerified: false,
          createdAt: new Date('2025-01-01').toISOString(),
        },
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockSignupResponse,
      } as Response);

      vi.mocked(prisma.user.update).mockResolvedValue({} as never);
      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'email-id' });

      const request = createMockPostRequest({
        name: 'Admin User',
        email: 'admin@example.com',
        password: 'SecurePassword123!',
        role: 'ADMIN',
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);
      const data = await parseResponse<{ data: { role: string } }>(response);
      expect(data.data.role).toBe('ADMIN');

      // Verify role was updated
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'new-admin-id' },
        data: { role: 'ADMIN' },
      });
    });

    it('should send welcome email after successful user creation', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const mockSignupResponse = {
        user: {
          id: 'new-user-id',
          name: 'Test User',
          email: 'test@example.com',
          emailVerified: false,
          createdAt: new Date('2025-01-01').toISOString(),
        },
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockSignupResponse,
      } as Response);

      vi.mocked(sendEmail).mockResolvedValue({ success: true, id: 'email-id' });

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'SecurePassword123!',
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);

      // Verify welcome email was sent
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Welcome to Sunrise',
        react: expect.anything(), // WelcomeEmail component
      });
    });

    it('should succeed even if welcome email fails (non-blocking)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const mockSignupResponse = {
        user: {
          id: 'new-user-id',
          name: 'Test User',
          email: 'test@example.com',
          emailVerified: false,
          createdAt: new Date('2025-01-01').toISOString(),
        },
      };

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => mockSignupResponse,
      } as Response);

      // Email sending fails
      vi.mocked(sendEmail).mockRejectedValue(new Error('Email service unavailable'));

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'SecurePassword123!',
      });

      // Act
      const response = await POST(request);

      // Assert - user creation should still succeed
      expect(response.status).toBe(201);
      const data = await parseResponse<{ success: boolean; data: { id: string } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe('new-user-id');

      // Give async error handler time to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify warning was logged (email failure is non-blocking)
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to send welcome email',
        expect.objectContaining({
          userId: 'new-user-id',
          error: 'Email service unavailable',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for duplicate email', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({
          message: 'User already exists',
        }),
      } as Response);

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'existing@example.com',
        password: 'SecurePassword123!',
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          code: 'EMAIL_TAKEN',
          message: 'Email already in use',
        },
      });
    });

    it('should return 400 for invalid input', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = createMockPostRequest({
        name: '', // Invalid: empty name
        email: 'not-an-email', // Invalid: malformed email
      });

      // Act
      const response = await POST(request);

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

    it('should handle better-auth signup failure', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({
          message: 'Signup service unavailable',
        }),
      } as Response);

      const request = createMockPostRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'SecurePassword123!',
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(500);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          message: 'Signup service unavailable',
        },
      });
    });
  });
});
