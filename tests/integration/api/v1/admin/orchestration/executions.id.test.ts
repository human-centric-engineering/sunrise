/**
 * Integration Test: Get execution detail
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * Flipped from the 5.1 stub in Session 5.2. The route now returns the
 * `AiWorkflowExecution` row plus a parsed `trace` array and a
 * structured projection. Ownership is scoped to `session.user.id`; a
 * cross-user lookup returns 404 (not 403).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/route';
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
    },
    aiCostLog: {
      findMany: vi.fn(),
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
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwz9';
const INVALID_ID = 'not-a-cuid';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    userId: ADMIN_ID,
    status: 'running',
    inputData: {},
    outputData: null,
    executionTrace: [
      {
        stepId: 'step1',
        stepType: 'llm_call',
        label: 'Generate',
        status: 'completed',
        output: 'hi',
        tokensUsed: 10,
        costUsd: 0.01,
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:01Z',
        durationMs: 1000,
      },
    ],
    currentStep: 'step2',
    currentStepLabel: 'Analyse',
    currentStepType: 'llm_call',
    currentStepStartedAt: new Date('2025-01-01T00:00:02Z'),
    errorMessage: null,
    totalTokensUsed: 10,
    totalCostUsd: 0.01,
    budgetLimitUsd: null,
    startedAt: new Date('2025-01-01'),
    completedAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    workflow: { id: WORKFLOW_ID, name: 'Test Workflow' },
    ...overrides,
  };
}

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('GET /api/v1/admin/orchestration/executions/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no cost logs. Tests that need them override this.
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([] as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid CUID param', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeGetRequest(), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 404 when execution belongs to a different user (not 403)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: OTHER_USER_ID }) as never
    );
    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns the execution row + parsed trace on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{
      success: boolean;
      data: {
        execution: {
          id: string;
          status: string;
          totalTokensUsed: number;
          currentStep: string;
          workflow: { id: string; name: string };
        };
        trace: Array<{ stepId: string; status: string }>;
        costEntries: unknown[];
      };
    }>(response);

    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data.execution.id).toBe(EXECUTION_ID);
    expect(data.data.execution.currentStep).toBe('step2');
    expect(data.data.execution.totalTokensUsed).toBe(10);
    expect(data.data.execution.workflow.name).toBe('Test Workflow');
    expect(data.data.trace).toHaveLength(1);
    expect(data.data.trace[0].stepId).toBe('step1');
    // No cost logs configured for this case → empty costEntries.
    expect(data.data.costEntries).toEqual([]);
  });

  it('returns currentStepDetails for a running execution with live columns set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    const data = await parseJson<{ data: { currentStepDetails: Record<string, unknown> | null } }>(
      response
    );

    expect(data.data.currentStepDetails).toEqual({
      stepId: 'step2',
      label: 'Analyse',
      stepType: 'llm_call',
      startedAt: '2025-01-01T00:00:02.000Z',
    });
  });

  it('returns null currentStepDetails when status is terminal', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({
        status: 'completed',
        currentStepLabel: null,
        currentStepType: null,
        currentStepStartedAt: null,
      }) as never
    );

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    const data = await parseJson<{ data: { currentStepDetails: unknown } }>(response);
    expect(data.data.currentStepDetails).toBeNull();
  });

  it('returns null currentStepDetails when live columns are partially populated', async () => {
    // Defensive: if the engine ever writes some columns but not others
    // (e.g. crash mid-update), the route shouldn't render a half-broken
    // running indicator — it must return null.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ currentStepType: null }) as never
    );

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    const data = await parseJson<{ data: { currentStepDetails: unknown } }>(response);
    expect(data.data.currentStepDetails).toBeNull();
  });

  it('returns costEntries from AiCostLog, keyed by metadata.stepId', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0.005,
        operation: 'chat',
        metadata: { stepId: 'step1', iteration: 0 },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 80,
        outputTokens: 30,
        totalCostUsd: 0.004,
        operation: 'chat',
        metadata: { stepId: 'step1', iteration: 1 },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      },
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 50,
        outputTokens: 25,
        totalCostUsd: 0.002,
        operation: 'chat',
        metadata: { stepId: 'step2' },
        createdAt: new Date('2025-01-01T00:00:02Z'),
      },
    ] as never);

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);

    const data = await parseJson<{
      data: { costEntries: Array<{ stepId: string; inputTokens: number; operation: string }> };
    }>(response);

    // Three entries, two attributed to step1 (multi-turn tool loop), one to step2.
    expect(data.data.costEntries).toHaveLength(3);
    expect(data.data.costEntries[0]).toMatchObject({
      stepId: 'step1',
      inputTokens: 100,
      operation: 'chat',
    });
    expect(data.data.costEntries[1]).toMatchObject({ stepId: 'step1', inputTokens: 80 });
    expect(data.data.costEntries[2]).toMatchObject({ stepId: 'step2', inputTokens: 50 });
  });

  it('drops cost logs with null/missing metadata.stepId', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      // No metadata at all — must be dropped.
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 5,
        outputTokens: 5,
        totalCostUsd: 0.001,
        operation: 'embedding',
        metadata: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      // Metadata present but no stepId — must be dropped.
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.002,
        operation: 'chat',
        metadata: { phase: 'summary' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      },
      // Valid — kept.
      {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0.005,
        operation: 'chat',
        metadata: { stepId: 'step1' },
        createdAt: new Date('2025-01-01T00:00:02Z'),
      },
    ] as never);

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    const data = await parseJson<{
      data: { costEntries: Array<{ stepId: string }> };
    }>(response);

    expect(data.data.costEntries).toHaveLength(1);
    expect(data.data.costEntries[0].stepId).toBe('step1');
  });

  it('queries AiCostLog scoped to the execution id (no leakage across runs)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecution() as never);

    await GET(makeGetRequest(), makeParams(EXECUTION_ID));

    expect(prisma.aiCostLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowExecutionId: EXECUTION_ID },
        orderBy: { createdAt: 'asc' },
      })
    );
  });

  it('omits the AiCostLog query when execution does not belong to caller (404 path)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ userId: OTHER_USER_ID }) as never
    );

    await GET(makeGetRequest(), makeParams(EXECUTION_ID));

    // Important: cross-user 404 path must short-circuit BEFORE the cost
    // query, so we never expose timing / count signal about another user's
    // execution.
    expect(prisma.aiCostLog.findMany).not.toHaveBeenCalled();
  });

  it('returns empty costEntries when trace is non-array (schema .catch() falls through)', async () => {
    // executionTraceSchema uses z.catch(), so a malformed trace returns []
    // — and the route still succeeds with empty costEntries (since the
    // execution row itself is intact).
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecution({ executionTrace: { not: 'an array' } }) as never
    );

    const response = await GET(makeGetRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);
    const data = await parseJson<{ data: { trace: unknown[]; costEntries: unknown[] } }>(response);
    expect(data.data.trace).toEqual([]);
  });
});
