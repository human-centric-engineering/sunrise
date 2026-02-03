/**
 * Unit Tests: GET /api/v1/admin/stats Route
 *
 * Tests the admin stats API route handler in isolation with mocked dependencies.
 *
 * Test Coverage:
 * - Authentication (unauthenticated request, non-admin user, admin user)
 * - Successful stats retrieval with complete data
 * - Role count handling (all roles present, some roles missing, null roles)
 * - Database health states (connected, error/disconnected)
 * - Error handling (database errors, unexpected errors)
 * - Response structure validation
 * - System information accuracy
 *
 * Branch Coverage:
 * - Line 48: if (!session) - unauthenticated
 * - Line 52: if (session.user.role !== 'ADMIN') - authorization
 * - Line 81: if (roleGroup.role) - null role handling
 * - Lines 93-95: || 0 operators - missing role fallback
 * - Line 103: dbHealth.connected ternary - database status
 * - Line 110: catch block - error handling
 *
 * @see app/api/v1/admin/stats/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/stats/route';
import type { SystemStats } from '@/types/admin';

/** Dummy request for handler invocation (auth is mocked via headers) */
const dummyRequest = new NextRequest('http://localhost:3000/api/v1/admin/stats');

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
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

// Mock database utilities
vi.mock('@/lib/db/utils', () => ({
  getDatabaseHealth: vi.fn(),
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

// Import mocked modules
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { getDatabaseHealth } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

/**
 * Response type interfaces
 */
interface SuccessResponse {
  success: true;
  data: SystemStats;
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
 * Helper function to create mock role counts
 * Uses 'as never' to bypass Prisma's strict typing in tests
 */
function createMockRoleCounts(roles: Array<{ role: string; count: number }>) {
  return roles.map((r) => ({
    role: r.role,
    _count: { role: r.count },
  })) as never;
}

/**
 * Test Suite: GET /api/v1/admin/stats
 */
describe('GET /api/v1/admin/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  describe('Authentication and Authorization', () => {
    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Unauthorized');

      // Should not query database when not authenticated
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.user.groupBy).not.toHaveBeenCalled();
      expect(getDatabaseHealth).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not an admin (USER role)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');

      // Should not query database when not authorized
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.user.groupBy).not.toHaveBeenCalled();
      expect(getDatabaseHealth).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not an admin (USER role)', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');
    });

    it('should proceed when user is an admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Mock database responses
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100) // total users
        .mockResolvedValueOnce(75) // verified users
        .mockResolvedValueOnce(10); // recent signups

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([
          { role: 'USER', count: 92 },
          { role: 'ADMIN', count: 8 },
        ])
      );

      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET(dummyRequest);

      // Assert
      expect(response.status).toBe(200);
      expect(prisma.user.count).toHaveBeenCalled();
    });

    it('should log debug message when admin stats requested', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

      // Mock database responses
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);

      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true, latency: 5 });

      // Act
      await GET(dummyRequest);

      // Assert
      expect(logger.debug).toHaveBeenCalledWith('Admin stats requested', {
        userId: adminSession.user.id,
      });
    });
  });

  describe('Successful Stats Retrieval', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('should return 200 with complete stats when all data is available', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100) // total users
        .mockResolvedValueOnce(75) // verified users
        .mockResolvedValueOnce(10); // recent signups

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([
          { role: 'USER', count: 92 },
          { role: 'ADMIN', count: 8 },
        ])
      );

      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data.users.total).toBe(100);
      expect(data.data.users.verified).toBe(75);
      expect(data.data.users.recentSignups).toBe(10);
      expect(data.data.users.byRole.USER).toBe(92);
      expect(data.data.users.byRole.ADMIN).toBe(8);
      expect(data.data.system.databaseStatus).toBe('connected');
    });

    it('should query database with correct parameters for recent signups', async () => {
      // Arrange
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const expectedDate = new Date(now - 24 * 60 * 60 * 1000);

      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);

      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true });

      // Act
      await GET(dummyRequest);

      // Assert
      expect(prisma.user.count).toHaveBeenNthCalledWith(3, {
        where: { createdAt: { gte: expect.any(Date) } },
      });

      // Verify the date is approximately 24 hours ago (allow 1 second tolerance)
      const callArgs = vi.mocked(prisma.user.count).mock.calls[2][0];

      const actualDate = (callArgs?.where?.createdAt as any)?.gte as Date;
      expect(actualDate.getTime()).toBeCloseTo(expectedDate.getTime(), -3); // within 1000ms
    });

    it('should execute all database queries in parallel', async () => {
      // Arrange
      let resolveCount1: () => void;
      let resolveCount2: () => void;
      let resolveCount3: () => void;
      let resolveGroupBy: () => void;
      let resolveHealth: () => void;

      const countPromise1 = new Promise<number>((resolve) => {
        resolveCount1 = () => resolve(100);
      });
      const countPromise2 = new Promise<number>((resolve) => {
        resolveCount2 = () => resolve(75);
      });
      const countPromise3 = new Promise<number>((resolve) => {
        resolveCount3 = () => resolve(10);
      });
      const groupByPromise = new Promise<Array<{ role: string; _count: { role: number } }>>(
        (resolve) => {
          resolveGroupBy = () => resolve([]);
        }
      );
      const healthPromise = new Promise<{ connected: boolean }>((resolve) => {
        resolveHealth = () => resolve({ connected: true });
      });

      vi.mocked(prisma.user.count)
        .mockReturnValueOnce(countPromise1 as never)
        .mockReturnValueOnce(countPromise2 as never)
        .mockReturnValueOnce(countPromise3 as never);

      vi.mocked(prisma.user.groupBy).mockReturnValue(groupByPromise as never);
      vi.mocked(getDatabaseHealth).mockReturnValue(healthPromise as never);

      // Act
      const responsePromise = GET(dummyRequest);

      // Wait a tick to ensure all promises are created
      await new Promise((resolve) => setImmediate(resolve));

      // Verify all functions called before any resolved
      expect(prisma.user.count).toHaveBeenCalledTimes(3);
      expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);
      expect(getDatabaseHealth).toHaveBeenCalledTimes(1);

      // Resolve all promises
      resolveCount1!();
      resolveCount2!();
      resolveCount3!();
      resolveGroupBy!();
      resolveHealth!();

      await responsePromise;
    });

    it('should log info message when stats fetched successfully', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);

      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true });

      // Act
      await GET(dummyRequest);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Admin stats fetched', {
        userId: adminSession.user.id,
      });
    });
  });

  describe('Role Count Handling', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true });
    });

    it('should handle all roles present in database', async () => {
      // Arrange
      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([
          { role: 'USER', count: 92 },
          { role: 'ADMIN', count: 8 },
        ])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole).toEqual({
        USER: 92,
        ADMIN: 8,
      });
    });

    it('should default to 0 for missing USER role', async () => {
      // Arrange
      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'ADMIN', count: 5 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole.USER).toBe(0);
      expect(data.data.users.byRole.ADMIN).toBe(5);
    });

    it('should default to 0 for missing ADMIN role', async () => {
      // Arrange
      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'USER', count: 50 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole.USER).toBe(50);
      expect(data.data.users.byRole.ADMIN).toBe(0);
    });

    it('should default all roles to 0 when no roles exist', async () => {
      // Arrange
      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole).toEqual({
        USER: 0,
        ADMIN: 0,
      });
    });

    it('should ignore role groups with null role', async () => {
      // Arrange - simulate edge case where role might be null
      vi.mocked(prisma.user.groupBy).mockResolvedValue([
        { role: 'USER', _count: { role: 40 } } as never,
        { role: null, _count: { role: 5 } } as never, // null role (shouldn't happen but test branch)
        { role: 'ADMIN', _count: { role: 3 } } as never,
      ] as never);

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole.USER).toBe(40);
      expect(data.data.users.byRole.ADMIN).toBe(3);
    });

    it('should handle partial role data correctly', async () => {
      // Arrange - only one role present
      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'USER', count: 100 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole.USER).toBe(100);
      expect(data.data.users.byRole.ADMIN).toBe(0);
    });
  });

  describe('Database Health States', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
    });

    it('should return "connected" status when database is healthy', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.databaseStatus).toBe('connected');
    });

    it('should return "error" status when database is unhealthy', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.databaseStatus).toBe('error');
    });

    it('should handle database health check with latency', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 150,
      });

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.databaseStatus).toBe('connected');
      // Latency is available but not exposed in the response (could be added in future)
    });

    it('should handle database health check without latency', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.databaseStatus).toBe('error');
    });
  });

  describe('System Information', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true });
    });

    it('should include Node.js version in system info', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.nodeVersion).toBe(process.version);
      expect(data.data.system.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('should include app version in system info', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.appVersion).toBeDefined();
      expect(typeof data.data.system.appVersion).toBe('string');
      expect(data.data.system.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should include environment in system info', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.environment).toBeDefined();
      expect(['development', 'production', 'test']).toContain(data.data.system.environment);
    });

    it('should include uptime in system info', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system.uptime).toBeDefined();
      expect(typeof data.data.system.uptime).toBe('number');
      expect(data.data.system.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should calculate uptime in seconds', async () => {
      // Act
      const response1 = await GET(dummyRequest);
      const data1 = await parseResponse<SuccessResponse>(response1);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const response2 = await GET(dummyRequest);
      const data2 = await parseResponse<SuccessResponse>(response2);

      // Assert - uptime should increase
      expect(data2.data.system.uptime).toBeGreaterThanOrEqual(data1.data.system.uptime);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('should handle database query errors', async () => {
      // Arrange
      vi.mocked(prisma.user.count).mockRejectedValue(new Error('Database connection failed'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });

    it('should handle getDatabaseHealth errors', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);
      vi.mocked(getDatabaseHealth).mockRejectedValue(new Error('Health check failed'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    it('should handle groupBy query errors', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      vi.mocked(prisma.user.groupBy).mockRejectedValue(new Error('GroupBy failed'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    it('should handle partial Promise.all failures', async () => {
      // Arrange - first count succeeds, second fails
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100)
        .mockRejectedValueOnce(new Error('Count failed'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    it('should handle auth session errors', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Session fetch failed'));

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    it('should handle unexpected error types', async () => {
      // Arrange
      vi.mocked(prisma.user.count).mockRejectedValue('String error' as never);

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });

  describe('Response Structure Validation', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(75)
        .mockResolvedValueOnce(10);
      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([
          { role: 'USER', count: 92 },
          { role: 'ADMIN', count: 8 },
        ])
      );
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true, latency: 5 });
    });

    it('should return standardized success response structure', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
      expect(data.success).toBe(true);
      expect(typeof data.data).toBe('object');
    });

    it('should include all required user stats fields', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users).toHaveProperty('total');
      expect(data.data.users).toHaveProperty('verified');
      expect(data.data.users).toHaveProperty('recentSignups');
      expect(data.data.users).toHaveProperty('byRole');
    });

    it('should include all required role breakdown fields', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.byRole).toHaveProperty('USER');
      expect(data.data.users.byRole).toHaveProperty('ADMIN');
    });

    it('should include all required system info fields', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.system).toHaveProperty('nodeVersion');
      expect(data.data.system).toHaveProperty('appVersion');
      expect(data.data.system).toHaveProperty('environment');
      expect(data.data.system).toHaveProperty('uptime');
      expect(data.data.system).toHaveProperty('databaseStatus');
    });

    it('should have correct data types for all fields', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(typeof data.data.users.total).toBe('number');
      expect(typeof data.data.users.verified).toBe('number');
      expect(typeof data.data.users.recentSignups).toBe('number');
      expect(typeof data.data.users.byRole.USER).toBe('number');
      expect(typeof data.data.users.byRole.ADMIN).toBe('number');
      expect(typeof data.data.system.nodeVersion).toBe('string');
      expect(typeof data.data.system.appVersion).toBe('string');
      expect(typeof data.data.system.environment).toBe('string');
      expect(typeof data.data.system.uptime).toBe('number');
      expect(typeof data.data.system.databaseStatus).toBe('string');
    });

    it('should set correct Content-Type header', async () => {
      // Act
      const response = await GET(dummyRequest);

      // Assert
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should not include meta field in success response', async () => {
      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse(response);

      // Assert
      expect(data).not.toHaveProperty('meta');
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getDatabaseHealth).mockResolvedValue({ connected: true });
    });

    it('should handle zero users', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(0) // total users
        .mockResolvedValueOnce(0) // verified users
        .mockResolvedValueOnce(0); // recent signups

      vi.mocked(prisma.user.groupBy).mockResolvedValue([]);

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.users.total).toBe(0);
      expect(data.data.users.verified).toBe(0);
      expect(data.data.users.recentSignups).toBe(0);
      expect(data.data.users.byRole.USER).toBe(0);
      expect(data.data.users.byRole.ADMIN).toBe(0);
    });

    it('should handle large user counts', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(1000000) // 1 million users
        .mockResolvedValueOnce(750000) // 750k verified
        .mockResolvedValueOnce(50000); // 50k recent

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([
          { role: 'USER', count: 999950 },
          { role: 'ADMIN', count: 50 },
        ])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.users.total).toBe(1000000);
      expect(data.data.users.verified).toBe(750000);
      expect(data.data.users.recentSignups).toBe(50000);
    });

    it('should handle all users being verified', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100) // total users
        .mockResolvedValueOnce(100) // all verified
        .mockResolvedValueOnce(10);

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'USER', count: 100 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.total).toBe(data.data.users.verified);
    });

    it('should handle no verified users', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(100) // total users
        .mockResolvedValueOnce(0) // none verified
        .mockResolvedValueOnce(100); // all recent

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'USER', count: 100 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.verified).toBe(0);
      expect(data.data.users.total).toBeGreaterThan(data.data.users.verified);
    });

    it('should handle all users being recent signups', async () => {
      // Arrange
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(50) // total users
        .mockResolvedValueOnce(25)
        .mockResolvedValueOnce(50); // all recent (registered in last 24h)

      vi.mocked(prisma.user.groupBy).mockResolvedValue(
        createMockRoleCounts([{ role: 'USER', count: 50 }])
      );

      // Act
      const response = await GET(dummyRequest);
      const data = await parseResponse<SuccessResponse>(response);

      // Assert
      expect(data.data.users.recentSignups).toBe(data.data.users.total);
    });
  });
});
