/**
 * Integration Test: Cancel a running or paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/cancel
 *
 * Key behaviours:
 *   - Transitions `running` or `paused_for_approval` execution to `cancelled`
 *   - Sets completedAt to now and errorMessage to 'Cancelled by user'
 *   - Returns 422 when the execution is already in a terminal status
 *   - Returns 422 for an invalid (non-CUID) id param
 *   - Ownership: cross-user access returns 404, not 403
 *
 * @see app/api/v1/admin/orchestration/executions/[id]/cancel/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/cancel/route';
import {
  createMockAuthSession,
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwz9';
const INVALID_ID = 'not-a-cuid';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    userId: ADMIN_ID,
    status: 'running',
    inputData: {},
    executionTrace: [],
    currentStep: 'step-1',
    errorMessage: null,
    totalTokensUsed: 0,
    totalCostUsd: 0,
    budgetLimitUsd: null,
    startedAt: new Date('2025-01-01'),
    completedAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makePostRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({}),
    url: `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/cancel`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/executions/:id/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(429);
    });
  });

  describe('CUID validation', () => {
    it('returns 400 for an invalid (non-CUID) id param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await POST(makePostRequest(), makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Execution lookup', () => {
    it('returns 404 when execution not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(404);
    });

    it('returns 404 when execution belongs to another user (ownership boundary)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ userId: OTHER_USER_ID }) as never
      );
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(404);
    });
  });

  describe('Status guard', () => {
    it('returns 400 when execution is already completed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'completed' }) as never
      );
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(400);
    });

    it('returns 400 when execution is already cancelled', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'cancelled' }) as never
      );
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(400);
    });

    it('returns 400 when execution is in failed status', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'failed' }) as never
      );
      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(400);
    });
  });

  describe('Happy path — cancel a running execution', () => {
    it('returns 200 with success data when cancelling a running execution', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'running' }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { success: boolean; executionId: string };
      }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.success).toBe(true);
      expect(data.data.executionId).toBe(EXECUTION_ID);
    });

    it('calls prisma.updateMany with status guard, cancelled status, and errorMessage', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'running' }) as never
      );

      await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledOnce();
      const updateCall = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock.calls[0][0] as {
        where: { id: string; status: { in: string[] } };
        data: { status: string; completedAt: Date; errorMessage: string };
      };
      expect(updateCall.where.id).toBe(EXECUTION_ID);
      expect(updateCall.where.status.in).toContain('running');
      expect(updateCall.where.status.in).toContain('paused_for_approval');
      expect(updateCall.data.status).toBe('cancelled');
      expect(updateCall.data.completedAt).toBeInstanceOf(Date);
      expect(updateCall.data.errorMessage).toBe('Cancelled by user');
    });

    it('returns 409 when execution status changed between find and update (race)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'running' }) as never
      );
      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(409);
    });
  });

  describe('Happy path — cancel a paused_for_approval execution', () => {
    it('returns 200 when cancelling a paused_for_approval execution', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({ status: 'paused_for_approval' }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));

      expect(response.status).toBe(200);
    });
  });

  // ─── Approver scoping ───────────────────────────────────────────────────────

  describe('Approver scoping', () => {
    const APPROVER_ID = 'cmjbv4i3x00003wsloputgwz8';

    function mockAdminWithId(id: string) {
      return createMockAuthSession({
        session: {
          id: 'session_123',
          userId: id,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          token: 'mock_session_token',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        user: {
          id,
          email: 'approver@example.com',
          name: 'Approver',
          emailVerified: true,
          image: null,
          role: 'ADMIN',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    function makeTraceWithApprover(approverIds: string[]) {
      return [
        {
          stepId: 'approval-step',
          stepType: 'human_approval',
          label: 'Review',
          status: 'awaiting_approval',
          output: { prompt: 'Approve?', approverUserIds: approverIds },
          tokensUsed: 0,
          costUsd: 0,
          startedAt: '2025-01-01T00:00:00Z',
          completedAt: '2025-01-01T00:00:00Z',
          durationMs: 0,
        },
      ];
    }

    it('allows delegated approver to cancel a paused_for_approval execution', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminWithId(APPROVER_ID));
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({
          userId: OTHER_USER_ID,
          status: 'paused_for_approval',
          executionTrace: makeTraceWithApprover([APPROVER_ID]),
        }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(200);
    });

    it('returns 404 for delegated approver trying to cancel a running execution', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminWithId(APPROVER_ID));
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({
          userId: OTHER_USER_ID,
          status: 'running',
          executionTrace: makeTraceWithApprover([APPROVER_ID]),
        }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(404);
    });

    it('returns 404 for non-owner admin not in approverUserIds', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminWithId(APPROVER_ID));
      vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
        makeExecution({
          userId: OTHER_USER_ID,
          status: 'paused_for_approval',
          executionTrace: makeTraceWithApprover(['cmjbv4i3x00003wsloputgwx1']),
        }) as never
      );

      const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
      expect(response.status).toBe(404);
    });
  });
});
