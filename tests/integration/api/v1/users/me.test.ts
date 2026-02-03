/**
 * Integration Test: Current User Endpoints
 *
 * Tests the /api/v1/users/me endpoints for user profile management.
 *
 * Test Coverage:
 * GET /api/v1/users/me:
 * - Successful retrieval (authenticated user)
 * - Includes extended profile fields (Phase 3.2)
 * - Unauthenticated (no session)
 *
 * PATCH /api/v1/users/me:
 * - Successful profile update
 * - Update extended profile fields (bio, phone, timezone, location)
 * - Email uniqueness validation
 * - Validation errors
 * - Unauthenticated (no session)
 *
 * DELETE /api/v1/users/me:
 * - Successful account deletion with confirmation
 * - Missing confirmation
 * - Incorrect confirmation
 * - Unauthenticated (no session)
 *
 * @see app/api/v1/users/me/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PATCH, DELETE } from '@/app/api/v1/users/me/route';
import type { NextRequest } from 'next/server';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

/**
 * Mock dependencies
 */

// Create shared mocks for cookie operations
const mockCookieDelete = vi.fn();
const mockCookieSet = vi.fn();

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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
  cookies: vi.fn(() =>
    Promise.resolve({
      delete: mockCookieDelete,
      set: mockCookieSet,
    })
  ),
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

/**
 * Helper function to create a mock NextRequest for GET
 */
function createMockGetRequest(): NextRequest {
  return {
    headers: new Headers(),
  } as unknown as NextRequest;
}

/**
 * Helper function to create a mock NextRequest with JSON body
 */
function createMockRequest(body: object): NextRequest {
  return {
    headers: new Headers({
      'Content-Type': 'application/json',
    }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
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
 * Mock user data with extended profile fields
 */
const mockUserData = {
  id: 'cmjbv4i3x00003wsloputgwul',
  name: 'Test User',
  email: 'test@example.com',
  emailVerified: true,
  image: null,
  role: 'USER',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  bio: 'Software developer',
  phone: '+1 (555) 123-4567',
  timezone: 'America/New_York',
  location: 'New York, NY',
  preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
};

describe('GET /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
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
  });

  describe('Successful Retrieval', () => {
    it('should return current user profile with all fields', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUserData);
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof mockUserData }>(response);

      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({
        id: mockUserData.id,
        name: mockUserData.name,
        email: mockUserData.email,
        role: mockUserData.role,
        bio: mockUserData.bio,
        phone: mockUserData.phone,
        timezone: mockUserData.timezone,
        location: mockUserData.location,
      });
    });

    it('should return user with null extended fields', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserData,
        bio: null,
        phone: null,
        location: null,
      });
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof mockUserData }>(response);

      expect(data.success).toBe(true);
      expect(data.data.bio).toBeNull();
      expect(data.data.phone).toBeNull();
      expect(data.data.location).toBeNull();
    });

    it('should return 401 if user not found in database', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
    });
  });
});

describe('PATCH /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockRequest({ name: 'New Name' });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('Successful Updates', () => {
    it('should update user name', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUserData,
        name: 'Updated Name',
      });
      const request = createMockRequest({ name: 'Updated Name' });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof mockUserData }>(response);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Updated Name');
    });

    it('should update extended profile fields', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const updatedData = {
        ...mockUserData,
        bio: 'Updated bio',
        phone: '+1 (555) 999-8888',
        timezone: 'Europe/London',
        location: 'London, UK',
      };
      vi.mocked(prisma.user.update).mockResolvedValue(updatedData);
      const request = createMockRequest({
        bio: 'Updated bio',
        phone: '+1 (555) 999-8888',
        timezone: 'Europe/London',
        location: 'London, UK',
      });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof updatedData }>(response);
      expect(data.success).toBe(true);
      expect(data.data.bio).toBe('Updated bio');
      expect(data.data.phone).toBe('+1 (555) 999-8888');
      expect(data.data.timezone).toBe('Europe/London');
      expect(data.data.location).toBe('London, UK');
    });

    it('should clear extended fields with null', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUserData,
        bio: null,
        phone: null,
        location: null,
      });
      const request = createMockRequest({
        bio: null,
        phone: null,
        location: null,
      });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof mockUserData }>(response);
      expect(data.success).toBe(true);
      expect(data.data.bio).toBeNull();
      expect(data.data.phone).toBeNull();
      expect(data.data.location).toBeNull();
    });
  });

  describe('Email Updates', () => {
    it('should update email when available', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null); // No existing user with this email
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUserData,
        email: 'newemail@example.com',
      });
      const request = createMockRequest({ email: 'newemail@example.com' });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: typeof mockUserData }>(response);
      expect(data.data.email).toBe('newemail@example.com');
    });

    it('should return 400 when email is already taken', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ...mockUserData,
        id: 'different-user-id',
        email: 'taken@example.com',
      });
      const request = createMockRequest({ email: 'taken@example.com' });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: {
          code: 'EMAIL_TAKEN',
        },
      });
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid name (too long)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({ name: 'a'.repeat(101) });

      // Act
      const response = await PATCH(request);

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

    it('should return 400 for invalid phone format', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({ phone: '+1-555-CALL-ME' });

      // Act
      const response = await PATCH(request);

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

    it('should return 400 for bio over 500 characters', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({ bio: 'a'.repeat(501) });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(400);
    });
  });
});

describe('DELETE /api/v1/users/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('Successful Deletion', () => {
    it('should delete account with correct confirmation', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: { deleted: boolean } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.deleted).toBe(true);

      // Verify user was deleted
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: mockAuthenticatedUser().user.id },
      });
    });
  });

  describe('Cookie Deletion', () => {
    it('should delete HTTP session cookie (better-auth.session_token)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.session_token');
    });

    it('should delete HTTP session data cookie (better-auth.session_data)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.session_data');
    });

    it('should delete HTTP CSRF cookie (better-auth.csrf_token)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.csrf_token');
    });

    it('should delete HTTP state cookie (better-auth.state)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.state');
    });

    it('should expire HTTPS session cookie with Secure attribute (__Secure-better-auth.session_token)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert - uses set() with secure: true so browsers accept the deletion
      expect(mockCookieSet).toHaveBeenCalledWith('__Secure-better-auth.session_token', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should expire HTTPS session data cookie with Secure attribute (__Secure-better-auth.session_data)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieSet).toHaveBeenCalledWith('__Secure-better-auth.session_data', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should expire HTTPS CSRF cookie with Secure attribute (__Secure-better-auth.csrf_token)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieSet).toHaveBeenCalledWith('__Secure-better-auth.csrf_token', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should expire HTTPS state cookie with Secure attribute (__Secure-better-auth.state)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert
      expect(mockCookieSet).toHaveBeenCalledWith('__Secure-better-auth.state', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should delete all better-auth cookies (4 via delete, 4 via set with Secure)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.delete).mockResolvedValue(mockUserData);
      const request = createMockRequest({ confirmation: 'DELETE' });

      // Act
      await DELETE(request);

      // Assert - HTTP cookies use delete()
      expect(mockCookieDelete).toHaveBeenCalledTimes(4);
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.session_token');
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.session_data');
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.csrf_token');
      expect(mockCookieDelete).toHaveBeenCalledWith('better-auth.state');

      // Assert - HTTPS __Secure- cookies use set() with secure: true
      const secureCookieOptions = { path: '/', secure: true, maxAge: 0 };
      expect(mockCookieSet).toHaveBeenCalledTimes(4);
      expect(mockCookieSet).toHaveBeenCalledWith(
        '__Secure-better-auth.session_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieSet).toHaveBeenCalledWith(
        '__Secure-better-auth.session_data',
        '',
        secureCookieOptions
      );
      expect(mockCookieSet).toHaveBeenCalledWith(
        '__Secure-better-auth.csrf_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieSet).toHaveBeenCalledWith(
        '__Secure-better-auth.state',
        '',
        secureCookieOptions
      );
    });
  });

  describe('Validation', () => {
    it('should return 400 without confirmation', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({});

      // Act
      const response = await DELETE(request);

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

    it('should return 400 with incorrect confirmation (lowercase)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({ confirmation: 'delete' });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(400);
    });

    it('should return 400 with incorrect confirmation (misspelled)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      const request = createMockRequest({ confirmation: 'DELTE' });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(400);
    });
  });
});
