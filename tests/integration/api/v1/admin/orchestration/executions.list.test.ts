/**
 * Integration Test: Admin Orchestration — Executions List
 *
 * GET /api/v1/admin/orchestration/executions
 *
 * @see app/api/v1/admin/orchestration/executions/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Results scoped to session.user.id
 * - Returns paginated response with workflow include
 * - No rate-limiting call in this route (just withAdminAuth guard)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/executions/route';
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
    aiWorkflowExecution: {
      findMany: vi.fn(),
      count: vi.fn(),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const EXEC_ID = 'cmjbv4i3x00003wsloputgwu3';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXEC_ID,
    userId: ADMIN_ID,
    workflowId: WORKFLOW_ID,
    status: 'completed',
    totalTokensUsed: 1000,
    totalCostUsd: 0.05,
    budgetLimitUsd: null,
    currentStep: null,
    inputData: {},
    outputData: {},
    errorMessage: null,
    startedAt: new Date('2025-01-01T10:00:00Z'),
    completedAt: new Date('2025-01-01T10:01:00Z'),
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    workflow: { id: WORKFLOW_ID, name: 'Test Workflow' },
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(search = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/executions${search}`,
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
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

  describe('Successful list', () => {
    it('returns paginated list of executions on success', async () => {
      const mockExecutions = [makeExecution()];
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue(mockExecutions as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);

      const response = await GET(makeRequest());
      const data = await parseJson<{
        success: boolean;
        data: unknown[];
        meta: { total: number; page: number; limit: number };
      }>(response);

      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.meta.total).toBe(1);
    });

    it('includes workflow info in each execution', async () => {
      const mockExecutions = [makeExecution()];
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue(mockExecutions as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);

      const response = await GET(makeRequest());
      const data = await parseJson<{
        success: boolean;
        data: Array<{ workflow: { id: string; name: string } }>;
      }>(response);

      expect(data.data[0].workflow.id).toBe(WORKFLOW_ID);
      expect(data.data[0].workflow.name).toBe('Test Workflow');
    });

    it('returns empty list when user has no executions', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);

      const response = await GET(makeRequest());
      const data = await parseJson<{
        success: boolean;
        data: unknown[];
        meta: { total: number };
      }>(response);

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(0);
      expect(data.meta.total).toBe(0);
    });
  });

  describe('Ownership scoping', () => {
    it('queries with userId scoped to session.user.id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);

      await GET(makeRequest());

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
      expect(vi.mocked(prisma.aiWorkflowExecution.count)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID }),
        })
      );
    });
  });

  describe('Query filters', () => {
    beforeEach(() => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    });

    it('passes workflowId filter into the where clause', async () => {
      await GET(makeRequest(`?workflowId=${WORKFLOW_ID}`));

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, workflowId: WORKFLOW_ID }),
        })
      );
    });

    it('passes status filter into the where clause', async () => {
      await GET(makeRequest('?status=completed'));

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ADMIN_ID, status: 'completed' }),
        })
      );
    });

    it('passes startDate only — sets createdAt.gte with no lte', async () => {
      await GET(makeRequest('?startDate=2025-01-01T00:00:00.000Z'));

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            createdAt: expect.objectContaining({
              gte: new Date('2025-01-01T00:00:00.000Z'),
            }),
          }),
        })
      );

      const callArg = vi.mocked(prisma.aiWorkflowExecution.findMany).mock.calls[0][0];
      const createdAt = (callArg as { where: { createdAt: { lte?: Date } } }).where.createdAt;
      expect(createdAt).not.toHaveProperty('lte');
    });

    it('passes endDate only — sets createdAt.lte with no gte', async () => {
      await GET(makeRequest('?endDate=2025-01-31T23:59:59.000Z'));

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            createdAt: expect.objectContaining({
              lte: new Date('2025-01-31T23:59:59.000Z'),
            }),
          }),
        })
      );

      const callArg = vi.mocked(prisma.aiWorkflowExecution.findMany).mock.calls[0][0];
      const createdAt = (callArg as { where: { createdAt: { gte?: Date } } }).where.createdAt;
      expect(createdAt).not.toHaveProperty('gte');
    });

    it('passes both startDate and endDate — sets createdAt.gte and createdAt.lte', async () => {
      await GET(
        makeRequest('?startDate=2025-01-01T00:00:00.000Z&endDate=2025-01-31T23:59:59.000Z')
      );

      expect(vi.mocked(prisma.aiWorkflowExecution.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: ADMIN_ID,
            createdAt: {
              gte: new Date('2025-01-01T00:00:00.000Z'),
              lte: new Date('2025-01-31T23:59:59.000Z'),
            },
          }),
        })
      );
    });
  });
});
