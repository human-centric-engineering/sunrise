/**
 * Integration Test: Approve paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/approve
 *
 * Flipped from the 5.1 stub in Session 5.2. The route now flips a
 * `paused_for_approval` row to `running`, persists the approval payload
 * onto the awaiting trace entry, and returns `{ success, resumeStepId }`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/approve/route';
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
      update: vi.fn(),
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

vi.mock('@/lib/orchestration/scheduling', () => ({
  resumeApprovedExecution: vi.fn(() => Promise.resolve()),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { resumeApprovedExecution } from '@/lib/orchestration/scheduling';

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
    status: 'paused_for_approval',
    inputData: {},
    executionTrace: [
      {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Approve?' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:00Z',
        durationMs: 0,
      },
    ],
    currentStep: 'approval-step',
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

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/approve`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('POST /api/v1/admin/orchestration/executions/:id/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

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

  it('returns 429 when adminLimiter blocks the request', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
    const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid CUID param', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest(), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 404 when execution belongs to another user (not 403)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: OTHER_USER_ID }) as never
    );
    const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 when execution is not paused_for_approval', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );
    const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('transitions the row to PENDING and returns resumeStepId on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const response = await POST(
      makePostRequest({ approvalPayload: { decision: 'approved' }, notes: 'Looks good' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(200);

    const data = await parseJson<{
      success: boolean;
      data: { success: boolean; resumeStepId: string };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data.resumeStepId).toBe('approval-step');

    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock
      .calls[0][0] as unknown as {
      where: { id: string; status: string };
      data: { status: string; executionTrace: Array<{ stepId: string; status: string }> };
    };
    expect(updateArg.where.status).toBe('paused_for_approval');
    expect(updateArg.data.status).toBe('pending');
    expect(updateArg.data.executionTrace[0].status).toBe('completed');

    // Regression: the admin approval route must trigger resume so the run
    // continues immediately instead of waiting for the maintenance tick.
    // Channel routes already do this; the admin route used to skip it,
    // which left runs sitting in PENDING after approval.
    expect(resumeApprovedExecution).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('returns 400 when notes exceeds 5000 characters', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(
      makePostRequest({ notes: 'x'.repeat(5001) }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when trace has no awaiting_approval entry (trace integrity)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Execution is paused_for_approval but the trace entries are all 'completed' —
    // this can happen if the trace was manually edited or a bug in checkpoint.
    // executeApproval now validates trace integrity and throws TRACE_CORRUPTED.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        executionTrace: [
          {
            stepId: 'approval-step',
            stepType: 'human_approval',
            label: 'Review',
            status: 'completed', // not 'awaiting_approval'
            output: null,
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:00Z',
            durationMs: 0,
          },
        ],
      }) as never
    );

    const response = await POST(
      makePostRequest({ approvalPayload: { approved: true } }),
      makeParams(EXECUTION_ID)
    );

    expect(response.status).toBe(400);
  });

  // ─── Approver scoping ───────────────────────────────────────────────────────

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

  it('allows non-owner admin who is in approverUserIds', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminWithId(APPROVER_ID));
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        userId: OTHER_USER_ID, // not the approver
        executionTrace: [
          {
            stepId: 'approval-step',
            stepType: 'human_approval',
            label: 'Review',
            status: 'awaiting_approval',
            output: { prompt: 'Approve?', approverUserIds: [APPROVER_ID] },
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:00Z',
            durationMs: 0,
          },
        ],
      }) as never
    );

    const response = await POST(
      makePostRequest({ approvalPayload: { decision: 'approved' } }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(200);
  });

  it('returns 404 for non-owner admin NOT in approverUserIds', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminWithId(APPROVER_ID));
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        userId: OTHER_USER_ID,
        executionTrace: [
          {
            stepId: 'approval-step',
            stepType: 'human_approval',
            label: 'Review',
            status: 'awaiting_approval',
            output: { prompt: 'Approve?', approverUserIds: ['cmjbv4i3x00003wsloputgwx1'] },
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:00Z',
            durationMs: 0,
          },
        ],
      }) as never
    );

    const response = await POST(makePostRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });
});
