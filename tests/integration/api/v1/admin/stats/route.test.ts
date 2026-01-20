/**
 * Integration Test: Admin Stats Endpoint (Phase 4.4)
 *
 * Tests the admin system statistics endpoint.
 *
 * Test Coverage:
 * GET /api/v1/admin/stats:
 * - Return user counts (admin)
 * - Return system info (admin)
 * - Unauthorized (non-admin)
 * - Unauthenticated
 *
 * @see app/api/v1/admin/stats/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/admin/stats/route';
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

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

// Mock database health check
vi.mock('@/lib/db/utils', () => ({
  getDatabaseHealth: vi.fn(() => Promise.resolve({ connected: true, latency: 5 })),
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
 * Helper to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Expected stats response type
 */
interface StatsResponse {
  success: boolean;
  data: {
    users: {
      total: number;
      verified: number;
      recentSignups: number;
      byRole: {
        USER: number;
        ADMIN: number;
        MODERATOR: number;
      };
    };
    system: {
      nodeVersion: string;
      appVersion: string;
      environment: string;
      uptime: number;
      databaseStatus: string;
    };
  };
}

describe('GET /api/v1/admin/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET();

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
      const response = await GET();

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

    it('should return 403 if user is moderator', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('MODERATOR'));

      // Act
      const response = await GET();

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('Successful Retrieval', () => {
    it('should return user statistics', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Mock the count calls
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(70) // verified
        .mockResolvedValueOnce(15); // recent signups

      // Mock the groupBy call for role counts
      vi.mocked(prisma.user.groupBy).mockResolvedValue([
        { role: 'USER', _count: { role: 85 } },
        { role: 'ADMIN', _count: { role: 5 } },
        { role: 'MODERATOR', _count: { role: 10 } },
      ] as never);

      // Act
      const response = await GET();

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<StatsResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data.users).toMatchObject({
        total: 100,
        verified: 70,
        recentSignups: 15,
        byRole: {
          USER: 85,
          ADMIN: 5,
          MODERATOR: 10,
        },
      });
    });

    it('should return system information', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(0);
      vi.mocked(prisma.user.groupBy).mockResolvedValue([] as never);

      // Act
      const response = await GET();

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<StatsResponse>(response);

      expect(data.data.system).toMatchObject({
        nodeVersion: expect.any(String),
        appVersion: expect.any(String),
        environment: expect.any(String),
        uptime: expect.any(Number),
        databaseStatus: 'connected',
      });
    });

    it('should handle zero users', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockResolvedValue(0);
      vi.mocked(prisma.user.groupBy).mockResolvedValue([] as never);

      // Act
      const response = await GET();

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<StatsResponse>(response);

      expect(data.data.users).toMatchObject({
        total: 0,
        verified: 0,
        recentSignups: 0,
        byRole: {
          USER: 0,
          ADMIN: 0,
          MODERATOR: 0,
        },
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count).mockRejectedValue(new Error('Database connection failed'));

      // Act
      const response = await GET();

      // Assert
      expect(response.status).toBe(500);
    });
  });
});
