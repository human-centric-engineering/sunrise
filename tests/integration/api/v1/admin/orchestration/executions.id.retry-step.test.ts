/**
 * Integration Test: Retry failed step
 *
 * POST /api/v1/admin/orchestration/executions/:id/retry-step
 *
 * Prepares a failed execution for retry from a specific step by
 * truncating the trace, recalculating totals, and resetting status.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/executions/[id]/retry-step/route';
import {
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
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeTrace() {
  return [
    {
      stepId: 'step-1',
      stepType: 'llm_call',
      label: 'Summarise',
      status: 'completed',
      output: { text: 'summary' },
      tokensUsed: 100,
      costUsd: 0.01,
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:00:01Z',
      durationMs: 1000,
    },
    {
      stepId: 'step-2',
      stepType: 'external_call',
      label: 'Fetch data',
      status: 'completed',
      output: { data: [1, 2, 3] },
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2025-01-01T00:00:01Z',
      completedAt: '2025-01-01T00:00:02Z',
      durationMs: 1000,
    },
    {
      stepId: 'step-3',
      stepType: 'llm_call',
      label: 'Analyse',
      status: 'failed',
      output: null,
      error: 'Step "Analyse" failed unexpectedly',
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2025-01-01T00:00:02Z',
      completedAt: '2025-01-01T00:00:03Z',
      durationMs: 1000,
    },
  ];
}

function makeFailedExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    userId: ADMIN_ID,
    status: 'failed',
    inputData: {},
    outputData: null,
    executionTrace: makeTrace(),
    totalTokensUsed: 100,
    totalCostUsd: 0.01,
    currentStep: 'step-3',
    errorMessage: 'Step "Analyse" failed unexpectedly',
    budgetLimitUsd: null,
    startedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/retry-step`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/executions/:id/retry-step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiWorkflowExecution.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(403);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('returns 400 for invalid execution id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const req = new NextRequest(
      `http://localhost:3000/api/v1/admin/orchestration/executions/${INVALID_ID}/retry-step`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: 'step-3' }),
      }
    );
    const res = await POST(req, { params: Promise.resolve({ id: INVALID_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when stepId is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(400);
  });

  // ── Not found ───────────────────────────────────────────────────────────────

  it('returns 404 when execution does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-user execution', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFailedExecution({ userId: 'other-user-id' })
    );
    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(404);
  });

  // ── Status guard ────────────────────────────────────────────────────────────

  it('returns 400 when execution is not failed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFailedExecution({ status: 'completed' })
    );
    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(400);
  });

  // ── Step not found ──────────────────────────────────────────────────────────

  it('returns 400 when stepId is not a failed step in trace', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFailedExecution()
    );
    const res = await POST(makeRequest({ stepId: 'step-1' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(400);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('truncates trace, recalculates totals, and resets status', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFailedExecution()
    );

    const res = await POST(makeRequest({ stepId: 'step-3' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      success: true,
      executionId: EXECUTION_ID,
      retryStepId: 'step-3',
      workflowId: WORKFLOW_ID,
    });

    // Verify the DB update call
    const updateCall = (prisma.aiWorkflowExecution.update as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const updateData = updateCall[0].data;

    // Trace should only contain step-1 and step-2 (failed step-3 removed)
    expect(updateData.executionTrace).toHaveLength(2);
    expect(updateData.executionTrace[0].stepId).toBe('step-1');
    expect(updateData.executionTrace[1].stepId).toBe('step-2');

    // Totals recalculated from remaining trace
    expect(updateData.totalTokensUsed).toBe(100); // step-1 tokens
    expect(updateData.totalCostUsd).toBe(0.01); // step-1 cost

    // Status and error reset
    expect(updateData.status).toBe('pending');
    expect(updateData.errorMessage).toBeNull();
    expect(updateData.completedAt).toBeNull();

    // currentStep set to last kept step
    expect(updateData.currentStep).toBe('step-2');
  });

  it('clears currentStep when retrying the first step', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const traceWithFirstFailed = [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'First',
        status: 'failed',
        output: null,
        error: 'Failed',
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:01Z',
        durationMs: 1000,
      },
    ];
    (prisma.aiWorkflowExecution.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFailedExecution({ executionTrace: traceWithFirstFailed, currentStep: 'step-1' })
    );

    const res = await POST(makeRequest({ stepId: 'step-1' }), {
      params: Promise.resolve({ id: EXECUTION_ID }),
    });
    expect(res.status).toBe(200);

    const updateData = (prisma.aiWorkflowExecution.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0].data;
    expect(updateData.executionTrace).toHaveLength(0);
    expect(updateData.currentStep).toBeNull();
    expect(updateData.totalTokensUsed).toBe(0);
    expect(updateData.totalCostUsd).toBe(0);
  });
});
