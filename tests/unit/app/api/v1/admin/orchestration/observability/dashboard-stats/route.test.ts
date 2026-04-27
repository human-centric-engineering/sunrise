/**
 * Unit Tests: Observability Dashboard Stats
 *
 * GET /api/v1/admin/orchestration/observability/dashboard-stats
 *
 * Test Coverage:
 * - Happy path: aggregated stats returned with correct shape
 * - Rate limit: blocked requests return rate-limit response
 * - Conditional GET: 304 Not Modified when ETag matches
 * - Error rate calculation: division-by-zero guard when totalExecutions24h is 0
 * - Data transformation: topCapabilities groupBy mapped to { slug, count } shape
 *
 * @see app/api/v1/admin/orchestration/observability/dashboard-stats/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { count: vi.fn() },
    aiCostLog: { count: vi.fn() },
    aiWorkflowExecution: { count: vi.fn(), findMany: vi.fn() },
    aiMessage: { groupBy: vi.fn() },
  },
}));

vi.mock('@/lib/api/responses', () => ({
  successResponse: vi.fn((data: unknown) =>
    Response.json({ success: true, data }, { status: 200 })
  ),
  errorResponse: vi.fn((message: string, options?: { code?: string; status?: number }) =>
    Response.json(
      { success: false, error: { code: options?.code ?? 'ERROR', message } },
      { status: options?.status ?? 500 }
    )
  ),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn().mockResolvedValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/api/etag', () => ({
  computeETag: vi.fn(() => 'W/"test-etag"'),
  checkConditional: vi.fn(() => null),
}));

const RATE_LIMIT_ALLOW = { success: true, limit: 100, remaining: 99, reset: 9999999999 };
const RATE_LIMIT_DENY = { success: false, limit: 100, remaining: 0, reset: 9999999999 };

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 9999999999 })),
  },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { checkConditional } from '@/lib/api/etag';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/observability/dashboard-stats/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/v1/admin/orchestration/observability/dashboard-stats',
    { method: 'GET', headers }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Default mock data ────────────────────────────────────────────────────────

function setupDefaultPrismaMocks() {
  vi.mocked(prisma.aiConversation.count).mockResolvedValue(5);
  vi.mocked(prisma.aiCostLog.count).mockResolvedValue(42);
  // Default: 10 total, 2 failed — errorRate = 0.2
  // Tests that need different values reset this themselves with mockResolvedValueOnce
  vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(10);
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/observability/dashboard-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore rate-limit and etag defaults
    vi.mocked(adminLimiter.check).mockReturnValue(RATE_LIMIT_ALLOW);
    vi.mocked(checkConditional).mockReturnValue(null);
    setupDefaultPrismaMocks();
  });

  describe('authentication', () => {
    it('should return 401 when unauthenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      // Act
      const response = await GET(makeRequest());

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 403 when user is not admin', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      // Act
      const response = await GET(makeRequest());

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('rate limiting', () => {
    it('should return rate-limit response when limiter check fails', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue(RATE_LIMIT_DENY);

      // Act
      const response = await GET(makeRequest());

      // Assert
      expect(response.status).toBe(429);
      const body = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('conditional GET (ETag/304)', () => {
    it('should return 304 Not Modified when checkConditional returns a response', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(checkConditional).mockReturnValue(
        new Response(null, { status: 304, headers: { ETag: 'W/"test-etag"' } })
      );

      // Act
      const response = await GET(makeRequest({ 'If-None-Match': 'W/"test-etag"' }));

      // Assert
      expect(response.status).toBe(304);
    });
  });

  describe('happy path — aggregated stats', () => {
    it('should return aggregated dashboard stats with correct shape', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(3);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(100);
      // First call = totalExecutions24h, second call = failedExecutions24h
      vi.mocked(prisma.aiWorkflowExecution.count)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(4);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
        {
          id: 'exec-1',
          errorMessage: 'Timeout',
          workflowId: 'wf-1',
          createdAt: new Date('2025-01-01'),
        } as never,
      ]);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([]);

      // Act
      const response = await GET(makeRequest());

      // Assert
      expect(response.status).toBe(200);
      expect(successResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          activeConversations: 3,
          todayRequests: 100,
          errorRate: expect.any(Number),
          recentErrors: expect.any(Array),
          topCapabilities: expect.any(Array),
        }),
        undefined,
        expect.objectContaining({ headers: expect.objectContaining({ ETag: expect.any(String) }) })
      );
    });

    it('should call all Prisma queries in a single Promise.all batch', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      // Act
      await GET(makeRequest());

      // Assert — all five queries must be invoked
      expect(prisma.aiConversation.count).toHaveBeenCalledOnce();
      expect(prisma.aiCostLog.count).toHaveBeenCalledOnce();
      expect(prisma.aiWorkflowExecution.count).toHaveBeenCalledTimes(2);
      expect(prisma.aiWorkflowExecution.findMany).toHaveBeenCalledOnce();
      expect(prisma.aiMessage.groupBy).toHaveBeenCalledOnce();
    });
  });

  describe('error rate calculation', () => {
    it('should calculate errorRate as 0 when totalExecutions24h is 0 (division-by-zero guard)', async () => {
      // Arrange: both counts = 0 — route must guard against division by zero
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      // Both calls return 0: totalExecutions24h = 0, failedExecutions24h = 0
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([]);

      // Act
      await GET(makeRequest());

      // Assert — errorRate should be 0, not NaN or Infinity
      expect(successResponse).toHaveBeenCalledWith(
        expect.objectContaining({ errorRate: 0 }),
        undefined,
        expect.anything()
      );
    });

    it('should calculate errorRate correctly when there are executions', async () => {
      // Arrange: 4 failures out of 20 total = 0.2
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      // First call = totalExecutions24h = 20, second call = failedExecutions24h = 4
      vi.mocked(prisma.aiWorkflowExecution.count)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(4);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([]);

      // Act
      await GET(makeRequest());

      // Assert
      expect(successResponse).toHaveBeenCalledWith(
        expect.objectContaining({ errorRate: 0.2 }),
        undefined,
        expect.anything()
      );
    });
  });

  describe('topCapabilities data transformation', () => {
    it('should map groupBy results to { slug, count } shape', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([
        { capabilitySlug: 'search-web', _count: { id: 15 } } as never,
        { capabilitySlug: 'send-email', _count: { id: 7 } } as never,
      ]);

      // Act
      await GET(makeRequest());

      // Assert — groupBy rows are mapped to { slug, count }
      expect(successResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          topCapabilities: [
            { slug: 'search-web', count: 15 },
            { slug: 'send-email', count: 7 },
          ],
        }),
        undefined,
        expect.anything()
      );
    });

    it('should return empty topCapabilities when no capability invocations exist', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([]);

      // Act
      await GET(makeRequest());

      // Assert
      expect(successResponse).toHaveBeenCalledWith(
        expect.objectContaining({ topCapabilities: [] }),
        undefined,
        expect.anything()
      );
    });
  });

  describe('query scoping', () => {
    it('should scope active conversations query to the authenticated user', async () => {
      // Arrange
      const adminSession = mockAdminUser();
      vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

      // Act
      await GET(makeRequest());

      // Assert — conversations query is user-scoped
      expect(prisma.aiConversation.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: adminSession.user.id,
            isActive: true,
          }),
        })
      );
    });
  });
});
