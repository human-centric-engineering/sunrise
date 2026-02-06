/**
 * Integration Test: Admin Logs Endpoint (Phase 4.4)
 *
 * Tests the admin logs viewer endpoint.
 *
 * Test Coverage:
 * GET /api/v1/admin/logs:
 * - Return logs (admin)
 * - Filter by level
 * - Search logs
 * - Pagination
 * - Unauthorized (non-admin)
 * - Unauthenticated
 *
 * @see app/api/v1/admin/logs/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/v1/admin/logs/route';
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

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

// Mock getRouteLogger - already mocked globally in tests/setup.ts

// Create mock log entries
const mockLogEntries = [
  {
    id: 'log_1',
    timestamp: '2025-01-01T10:00:00.000Z',
    level: 'info' as const,
    message: 'User logged in',
    context: { userId: 'user_123' },
  },
  {
    id: 'log_2',
    timestamp: '2025-01-01T10:01:00.000Z',
    level: 'error' as const,
    message: 'Database connection failed',
    context: { error: 'Connection timeout' },
  },
  {
    id: 'log_3',
    timestamp: '2025-01-01T10:02:00.000Z',
    level: 'warn' as const,
    message: 'High memory usage detected',
    context: { memory: '90%' },
  },
  {
    id: 'log_4',
    timestamp: '2025-01-01T10:03:00.000Z',
    level: 'debug' as const,
    message: 'Processing request',
    context: { path: '/api/test' },
  },
  {
    id: 'log_5',
    timestamp: '2025-01-01T10:04:00.000Z',
    level: 'info' as const,
    message: 'User created account',
    context: { email: 'test@example.com' },
  },
];

// Mock the log buffer module
vi.mock('@/lib/admin/logs', () => ({
  getLogEntries: vi.fn(() => ({ entries: mockLogEntries, total: mockLogEntries.length })),
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { getLogEntries } from '@/lib/admin/logs';

/**
 * Helper to create mock NextRequest
 */
function createMockRequest(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/logs');
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
 * Helper to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Expected logs response type
 */
interface LogsResponse {
  success: boolean;
  data: Array<{
    id: string;
    timestamp: string;
    level: string;
    message: string;
    context: Record<string, unknown>;
  }>;
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

describe('GET /api/v1/admin/logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    vi.mocked(getLogEntries).mockReturnValue({
      entries: mockLogEntries,
      total: mockLogEntries.length,
    });
  });

  describe('Authentication & Authorization', () => {
    it('should return 401 if not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const request = createMockRequest();

      // Act
      const response = await GET(request);

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
      const request = createMockRequest();

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
    it('should return all logs with pagination', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(5);
      expect(data.meta).toMatchObject({
        page: 1,
        total: 5,
      });
    });

    it('should filter logs by level', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const errorLogs = mockLogEntries.filter((log) => log.level === 'error');
      vi.mocked(getLogEntries).mockReturnValue({ entries: errorLogs, total: errorLogs.length });

      const request = createMockRequest({ level: 'error' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.data).toHaveLength(1);
      expect(data.data[0].level).toBe('error');
      expect(data.data[0].message).toBe('Database connection failed');
    });

    it('should search logs by message', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const matchingLogs = mockLogEntries.filter((log) =>
        log.message.toLowerCase().includes('user')
      );
      vi.mocked(getLogEntries).mockReturnValue({
        entries: matchingLogs,
        total: matchingLogs.length,
      });

      const request = createMockRequest({ search: 'user' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.data.length).toBeGreaterThan(0);
      data.data.forEach((log) => {
        expect(log.message.toLowerCase()).toContain('user');
      });
    });

    it('should support pagination', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getLogEntries).mockReturnValue({ entries: [mockLogEntries[2]], total: 5 });

      const request = createMockRequest({ page: '2', limit: '2' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.meta).toMatchObject({
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
    });

    it('should return empty array when no logs match filters', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(getLogEntries).mockReturnValue({ entries: [], total: 0 });

      const request = createMockRequest({ search: 'nonexistent' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(0);
      expect(data.meta.total).toBe(0);
    });

    it('should combine level filter and search', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const matchingLogs = mockLogEntries.filter(
        (log) => log.level === 'info' && log.message.toLowerCase().includes('user')
      );
      vi.mocked(getLogEntries).mockReturnValue({
        entries: matchingLogs,
        total: matchingLogs.length,
      });

      const request = createMockRequest({ level: 'info', search: 'user' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
      const data = await parseResponse<LogsResponse>(response);

      expect(data.data.length).toBeGreaterThan(0);
      data.data.forEach((log) => {
        expect(log.level).toBe('info');
        expect(log.message.toLowerCase()).toContain('user');
      });
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid page parameter', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockRequest({ page: 'invalid' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid limit parameter', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockRequest({ limit: '-1' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid level parameter', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const request = createMockRequest({ level: 'invalid-level' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(400);
    });
  });
});
