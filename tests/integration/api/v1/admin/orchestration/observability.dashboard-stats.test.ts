/**
 * Integration Test: Admin Orchestration — Observability Dashboard Stats
 *
 * GET /api/v1/admin/orchestration/observability/dashboard-stats
 *
 * @see app/api/v1/admin/orchestration/observability/dashboard-stats/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Runs 6 queries in Promise.all and returns aggregated stats
 * - errorRate = 0 when totalExecutions24h === 0 (no divide-by-zero)
 * - topCapabilities mapped correctly from groupBy results
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/observability/dashboard-stats/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      count: vi.fn(),
    },
    aiCostLog: {
      count: vi.fn(),
    },
    aiWorkflowExecution: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    aiMessage: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/api/v1/admin/orchestration/observability/dashboard-stats',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function setupDefaultMocks() {
  vi.mocked(prisma.aiConversation.count).mockResolvedValue(3);
  vi.mocked(prisma.aiCostLog.count).mockResolvedValue(42);
  // totalExecutions24h, then failedExecutions24h
  vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValueOnce(10).mockResolvedValueOnce(2);
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
    {
      id: 'cmjbv4i3x00003wsloputgwu5',
      errorMessage: 'Timeout error',
      workflowId: 'wf-1',
      createdAt: new Date('2025-01-01'),
    },
  ] as never);
  vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([
    { capabilitySlug: 'web-search', _count: { id: 15 } },
    { capabilitySlug: 'code-runner', _count: { id: 8 } },
  ] as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/observability/dashboard-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Successful stats retrieval', () => {
    it('returns all expected stat fields on success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      setupDefaultMocks();

      const response = await GET(makeRequest());
      const result = await parseJson<{
        success: boolean;
        data: {
          activeConversations: number;
          todayRequests: number;
          errorRate: number;
          recentErrors: unknown[];
          topCapabilities: unknown[];
        };
      }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(result.success).toBe(true);
      expect(result.data.activeConversations).toBe(3);
      expect(result.data.todayRequests).toBe(42);
      expect(typeof result.data.errorRate).toBe('number');
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(Array.isArray(result.data.recentErrors)).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(Array.isArray(result.data.topCapabilities)).toBe(true);
    });

    it('calculates errorRate as failedExecutions / totalExecutions', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      // 20 total, 5 failed → 0.25
      vi.mocked(prisma.aiWorkflowExecution.count)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(5);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

      const response = await GET(makeRequest());
      const result = await parseJson<{ success: boolean; data: { errorRate: number } }>(response);

      expect(result.data.errorRate).toBeCloseTo(0.25);
    });

    it('returns errorRate of 0 when no executions exist (no divide-by-zero)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      // 0 total, 0 failed
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

      const response = await GET(makeRequest());
      const result = await parseJson<{ success: boolean; data: { errorRate: number } }>(response);

      expect(response.status).toBe(200);
      expect(result.data.errorRate).toBe(0);
    });

    it('maps topCapabilities correctly from groupBy results', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
      vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([
        { capabilitySlug: 'web-search', _count: { id: 15 } },
        { capabilitySlug: 'code-runner', _count: { id: 8 } },
      ] as never);

      const response = await GET(makeRequest());
      const result = await parseJson<{
        success: boolean;
        data: { topCapabilities: Array<{ slug: string; count: number }> };
      }>(response);

      expect(result.data.topCapabilities).toHaveLength(2);
      expect(result.data.topCapabilities[0]).toEqual({ slug: 'web-search', count: 15 });
      expect(result.data.topCapabilities[1]).toEqual({ slug: 'code-runner', count: 8 });
    });

    it('returns recentErrors with id, errorMessage, workflowId, createdAt', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      setupDefaultMocks();

      const response = await GET(makeRequest());
      const result = await parseJson<{
        success: boolean;
        data: {
          recentErrors: Array<{
            id: string;
            errorMessage: string | null;
            workflowId: string;
          }>;
        };
      }>(response);

      const err = result.data.recentErrors[0];
      expect(err.id).toBeDefined();
      expect(err.errorMessage).toBe('Timeout error');
      expect(err.workflowId).toBe('wf-1');
    });

    it('scopes conversation and execution queries to session.user.id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      setupDefaultMocks();

      await GET(makeRequest());

      expect(vi.mocked(prisma.aiConversation.count)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
    });
  });
});
