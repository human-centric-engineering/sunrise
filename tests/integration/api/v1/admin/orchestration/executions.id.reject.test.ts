/**
 * Integration Test: Reject paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/reject
 *
 * Transitions a `paused_for_approval` row to `cancelled` with a
 * rejection reason recorded in `errorMessage`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/reject/route';
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
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwz9';
const INVALID_ID = 'not-a-cuid';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: 'cmjbv4i3x00003wsloputgwu2',
    userId: ADMIN_ID,
    status: 'paused_for_approval',
    inputData: {},
    executionTrace: [
      {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Approve this action?' },
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
    url: `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/reject`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('POST /api/v1/admin/orchestration/executions/:id/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(403);
  });

  it('returns 429 when adminLimiter blocks the request', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid CUID param', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 404 when execution belongs to another user (not 403)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: OTHER_USER_ID }) as never
    );
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 when execution is not paused_for_approval (running)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'running' }) as never
    );
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when execution is not paused_for_approval (completed)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ status: 'completed' }) as never
    );
    const response = await POST(makePostRequest({ reason: 'No' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reason is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest({}), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reason is empty string', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(makePostRequest({ reason: '' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(400);
  });

  it('returns 400 when reason exceeds 5000 characters', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await POST(
      makePostRequest({ reason: 'x'.repeat(5001) }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(400);
  });

  it('transitions the row to CANCELLED with "Rejected: ..." errorMessage on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const response = await POST(
      makePostRequest({ reason: 'Does not meet compliance requirements' }),
      makeParams(EXECUTION_ID)
    );
    expect(response.status).toBe(200);

    const data = await parseJson<{
      success: boolean;
      data: { success: boolean; executionId: string };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.executionId).toBe(EXECUTION_ID);

    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.aiWorkflowExecution.updateMany).mock
      .calls[0][0] as unknown as {
      where: { id: string; status: string };
      data: { status: string; errorMessage: string; completedAt: Date };
    };
    expect(updateArg.where.status).toBe('paused_for_approval');
    expect(updateArg.data.status).toBe('cancelled');
    expect(updateArg.data.errorMessage).toBe('Rejected: Does not meet compliance requirements');
    expect(updateArg.data.completedAt).toBeInstanceOf(Date);
  });

  it('returns 409 when concurrent rejection races (updateMany count === 0)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 0 } as never);

    const response = await POST(makePostRequest({ reason: 'Rejected' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(409);
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
            output: { prompt: 'Approve this action?', approverUserIds: [APPROVER_ID] },
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
      makePostRequest({ reason: 'Does not meet requirements' }),
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
            output: {
              prompt: 'Approve this action?',
              approverUserIds: ['cmjbv4i3x00003wsloputgwx1'],
            },
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:00:00Z',
            durationMs: 0,
          },
        ],
      }) as never
    );

    const response = await POST(makePostRequest({ reason: 'Rejected' }), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });
});
