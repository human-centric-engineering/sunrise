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
      };
    }>(response);

    expect(data.success).toBe(true);
    expect(data.data.execution.id).toBe(EXECUTION_ID);
    expect(data.data.execution.currentStep).toBe('step2');
    expect(data.data.execution.totalTokensUsed).toBe(10);
    expect(data.data.execution.workflow.name).toBe('Test Workflow');
    expect(data.data.trace).toHaveLength(1);
    expect(data.data.trace[0].stepId).toBe('step1');
  });
});
