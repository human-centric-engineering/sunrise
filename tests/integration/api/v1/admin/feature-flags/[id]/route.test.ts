/**
 * Integration Test: Admin Feature Flag Individual Endpoints (Phase 4.4)
 *
 * Tests the admin feature flag GET, PATCH, DELETE endpoints.
 *
 * Test Coverage:
 * GET /api/v1/admin/feature-flags/[id]:
 * - Get single flag (admin)
 * - Flag not found
 * - Unauthorized
 *
 * PATCH /api/v1/admin/feature-flags/[id]:
 * - Update flag enabled state
 * - Update flag description
 * - Validation errors
 * - Flag not found
 * - Unauthorized
 *
 * DELETE /api/v1/admin/feature-flags/[id]:
 * - Delete flag
 * - Flag not found
 * - Unauthorized
 *
 * @see app/api/v1/admin/feature-flags/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/feature-flags/[id]/route';
import type { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import type { FeatureFlag } from '@/types/prisma';

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

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    featureFlag: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock feature-flags utilities
vi.mock('@/lib/feature-flags', () => ({
  updateFlag: vi.fn(),
  deleteFlag: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { updateFlag, deleteFlag } from '@/lib/feature-flags';

/**
 * Helper types
 */
interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Helper to create mock NextRequest for GET
 */
function createMockGetRequest(): NextRequest {
  return {
    headers: new Headers(),
  } as unknown as NextRequest;
}

/**
 * Helper to create mock NextRequest for PATCH
 */
function createMockPatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

/**
 * Helper to create mock NextRequest for DELETE
 */
function createMockDeleteRequest(): NextRequest {
  return {
    headers: new Headers(),
  } as unknown as NextRequest;
}

/**
 * Helper to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Valid CUID for testing (must match cuid format)
 */
const TEST_FLAG_ID = 'cmjbv4i3x00003wsloputgwul';
const NONEXISTENT_ID = 'cmjbv4i3x00004wsloputgwum';

/**
 * Helper to create mock feature flag
 */
function createMockFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    id: TEST_FLAG_ID,
    name: 'TEST_FLAG',
    enabled: false,
    description: 'Test flag',
    metadata: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    createdBy: null,
    ...overrides,
  };
}

/**
 * Helper to create route context
 */
function createContext(id: string): RouteContext {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/v1/admin/feature-flags/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockGetRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await GET(request, context);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = createMockGetRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await GET(request, context);

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('Successful Retrieval', () => {
    it('should return single feature flag', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const mockFlag = createMockFlag();
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(mockFlag);

      const request = createMockGetRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await GET(request, context);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('TEST_FLAG');
    });

    it('should return 404 if flag not found', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      const request = createMockGetRequest();
      const context = createContext(NONEXISTENT_ID);

      // Act
      const response = await GET(request, context);

      // Assert
      expect(response.status).toBe(404);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    });
  });
});

describe('PATCH /api/v1/admin/feature-flags/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockPatchRequest({ enabled: true });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = createMockPatchRequest({ enabled: true });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('Successful Update', () => {
    it('should update flag enabled state', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingFlag = createMockFlag({ enabled: false });
      const updatedFlag = createMockFlag({ enabled: true });

      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(existingFlag);
      vi.mocked(updateFlag).mockResolvedValue(updatedFlag);

      const request = createMockPatchRequest({ enabled: true });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.success).toBe(true);
      expect(data.data.enabled).toBe(true);
    });

    it('should update flag description', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingFlag = createMockFlag();
      const updatedFlag = createMockFlag({ description: 'Updated description' });

      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(existingFlag);
      vi.mocked(updateFlag).mockResolvedValue(updatedFlag);

      const request = createMockPatchRequest({ description: 'Updated description' });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.data.description).toBe('Updated description');
    });

    it('should update multiple fields at once', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingFlag = createMockFlag();
      const updatedFlag = createMockFlag({
        enabled: true,
        description: 'New description',
      });

      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(existingFlag);
      vi.mocked(updateFlag).mockResolvedValue(updatedFlag);

      const request = createMockPatchRequest({
        enabled: true,
        description: 'New description',
      });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.data.enabled).toBe(true);
      expect(data.data.description).toBe('New description');
    });
  });

  describe('Error Cases', () => {
    it('should return 404 if flag not found', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      const request = createMockPatchRequest({ enabled: true });
      const context = createContext(NONEXISTENT_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid enabled value', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(createMockFlag());
      const request = createMockPatchRequest({ enabled: 'not-a-boolean' });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(400);
    });

    it('should return 400 for description too long', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(createMockFlag());
      const request = createMockPatchRequest({ description: 'a'.repeat(501) });
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await PATCH(request, context);

      // Assert
      expect(response.status).toBe(400);
    });
  });
});

describe('DELETE /api/v1/admin/feature-flags/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockDeleteRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = createMockDeleteRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('Successful Deletion', () => {
    it('should delete feature flag', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const mockFlag = createMockFlag();
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(mockFlag);
      vi.mocked(deleteFlag).mockResolvedValue(undefined);

      const request = createMockDeleteRequest();
      const context = createContext(TEST_FLAG_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{
        success: boolean;
        data: { id: string; deleted: boolean };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(TEST_FLAG_ID);
      expect(data.data.deleted).toBe(true);
    });
  });

  describe('Error Cases', () => {
    it('should return 404 if flag not found', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      const request = createMockDeleteRequest();
      const context = createContext(NONEXISTENT_ID);

      // Act
      const response = await DELETE(request, context);

      // Assert
      expect(response.status).toBe(404);
    });
  });
});
