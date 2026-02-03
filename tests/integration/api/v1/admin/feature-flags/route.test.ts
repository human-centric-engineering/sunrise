/**
 * Integration Test: Admin Feature Flags Endpoints (Phase 4.4)
 *
 * Tests the admin feature flags CRUD endpoints.
 *
 * Test Coverage:
 * GET /api/v1/admin/feature-flags:
 * - List all flags (admin)
 * - Unauthorized (non-admin)
 * - Unauthenticated
 *
 * POST /api/v1/admin/feature-flags:
 * - Create new flag
 * - Validation errors
 * - Duplicate name conflict
 * - Unauthorized
 *
 * @see app/api/v1/admin/feature-flags/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/feature-flags/route';

/** Dummy request for handler invocation (auth is mocked via headers) */
const dummyRequest = new NextRequest('http://localhost:3000/api/v1/admin/feature-flags');
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
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
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

/**
 * Helper to create mock NextRequest for POST
 */
function createMockPostRequest(body: Record<string, unknown>): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
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
 * Helper to create mock feature flag
 */
function createMockFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    id: 'flag_123',
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

describe('GET /api/v1/admin/feature-flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET(dummyRequest);

      // Assert
      expect(response.status).toBe(401);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: { code: 'UNAUTHORIZED' },
      });
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(dummyRequest);

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
    it('should return all feature flags for admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const mockFlags = [
        createMockFlag({ name: 'MAINTENANCE_MODE', enabled: false }),
        createMockFlag({ name: 'BETA_FEATURES', enabled: true }),
      ];
      vi.mocked(prisma.featureFlag.findMany).mockResolvedValue(mockFlags);

      // Act
      const response = await GET(dummyRequest);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag[] }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.data[0].name).toBe('MAINTENANCE_MODE');
      expect(data.data[1].name).toBe('BETA_FEATURES');
    });

    it('should return empty array when no flags exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([]);

      // Act
      const response = await GET(dummyRequest);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag[] }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
    });
  });
});

describe('POST /api/v1/admin/feature-flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockPostRequest({ name: 'NEW_FLAG' });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const request = createMockPostRequest({ name: 'NEW_FLAG' });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('Successful Creation', () => {
    it('should create a new feature flag', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      const newFlag = createMockFlag({
        name: 'NEW_FEATURE',
        description: 'A new feature',
        enabled: true,
      });
      vi.mocked(prisma.featureFlag.create).mockResolvedValue(newFlag);

      const request = createMockPostRequest({
        name: 'NEW_FEATURE',
        description: 'A new feature',
        enabled: true,
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('NEW_FEATURE');
      expect(data.data.enabled).toBe(true);
    });

    it('should create flag with defaults when only name provided', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      const newFlag = createMockFlag({ name: 'SIMPLE_FLAG', enabled: false });
      vi.mocked(prisma.featureFlag.create).mockResolvedValue(newFlag);

      const request = createMockPostRequest({ name: 'SIMPLE_FLAG' });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(201);
      const data = await parseResponse<{ success: boolean; data: FeatureFlag }>(response);
      expect(data.data.name).toBe('SIMPLE_FLAG');
      expect(data.data.enabled).toBe(false);
    });
  });

  describe('Validation Errors', () => {
    it('should return 400 for missing name', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockPostRequest({});

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    });

    it('should return 400 for invalid name format', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockPostRequest({ name: 'invalid-name' });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(400);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    });

    it('should return 400 for description too long', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockPostRequest({
        name: 'TEST_FLAG',
        description: 'a'.repeat(501),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(400);
    });
  });

  describe('Conflict Errors', () => {
    it('should return 409 for duplicate flag name', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(createMockFlag());

      const request = createMockPostRequest({ name: 'TEST_FLAG' });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(409);
      const data = await parseResponse(response);
      expect(data).toMatchObject({
        success: false,
        error: { code: 'CONFLICT' },
      });
    });
  });
});
