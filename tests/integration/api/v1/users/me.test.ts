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
import { GET, PATCH } from '@/app/api/v1/users/me/route';
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
      // PATCH delegates an email change here rather than writing it (#489).
      changeEmail: vi.fn().mockResolvedValue({ status: true }),
    },
  },
}));

// better-auth's password verifier — the email change re-authenticates first.
vi.mock('better-auth/crypto', () => ({
  verifyPassword: vi.fn().mockResolvedValue(true),
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // Consulted to decide whether a current password is required.
    account: {
      findFirst: vi.fn(),
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

// Mock getRouteLogger - already mocked globally in tests/setup.ts

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
  accountType: 'HUMAN' as const,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  bio: 'Software developer',
  phone: '+1 (555) 123-4567',
  timezone: 'America/New_York',
  location: 'New York, NY',
  preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
  signupOrgId: null,
  signupOrgRole: null,
  erasureRequestedAt: null,
  erasureRequestedBy: null,
  erasureReason: null,
  erasureAttempts: 0,
  erasureNextAttemptAt: null,
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

      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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

      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
    // `clearAllMocks` resets call history but not a `mockResolvedValue` set by
    // an earlier test, so give `account.findFirst` an explicit default here —
    // otherwise a later test silently inherits whichever "has a password?"
    // answer the previous one configured.
    vi.clearAllMocks();
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null);
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
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
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.bio).toBeNull();
      expect(data.data.phone).toBeNull();
      expect(data.data.location).toBeNull();
    });
  });

  describe('Email Updates', () => {
    it('should start a change flow rather than writing the new address', async () => {
      // Since #489 the address does not move in this request. It is handed to
      // better-auth, which requires approval at the CURRENT address first, so
      // the response still carries the old address plus a flag saying the flow
      // started. Writing it here is exactly what made a stolen session enough
      // for permanent account takeover.
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null); // No existing user with this email
      // Cast: the route `select`s only `password`, not a full Account row.
      vi.mocked(prisma.account.findFirst).mockResolvedValue({ password: 'stored-hash' } as never);
      // updatedAt differs from mockUserData.updatedAt to prove the response comes from the DB,
      // not from echoing the request body
      const dbUpdatedAt = new Date('2025-06-01T12:00:00.000Z');
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockUserData,
        updatedAt: dbUpdatedAt,
      });
      const request = createMockRequest({
        email: 'newemail@example.com',
        currentPassword: 'correct-horse',
      });

      // Act
      const response = await PATCH(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{
        success: boolean;
        data: typeof mockUserData & { updatedAt: string; emailChangeRequested: boolean };
      }>(response);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status and data shape checks
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // Still the OLD address — nothing has moved yet.
      expect(data.data.email).toBe(mockUserData.email);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.emailChangeRequested).toBe(true);
      // Verify the handler-derived updatedAt comes from the DB return, not the request body
      expect(new Date(data.data.updatedAt).toISOString()).toBe(dbUpdatedAt.toISOString());
      // The address must NOT be part of the Prisma write.
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cmjbv4i3x00003wsloputgwul' },
        })
      );
      const updateArg = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data.email).toBeUndefined();
      // It went to better-auth instead.
      expect(auth.api.changeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ body: { newEmail: 'newemail@example.com' } })
      );
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
