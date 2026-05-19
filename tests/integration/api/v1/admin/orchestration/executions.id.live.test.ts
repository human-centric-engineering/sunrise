/**
 * Integration Test: Get execution live snapshot
 *
 * GET /api/v1/admin/orchestration/executions/:id/live
 *
 * Returns the same narrow status fields as `/status` plus the parsed trace,
 * cost-attribution rows, and `currentRunningSteps` derived from the live
 * `currentStep*` columns. Designed for ~1s polling from the detail page.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/live/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findUnique: vi.fn() },
    aiWorkflowRunningStep: { findMany: vi.fn() },
    aiCostLog: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwz9';
const INVALID_ID = 'not-a-cuid';

function makeExecutionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    userId: ADMIN_ID,
    status: 'running',
    currentStep: 'step-2',
    errorMessage: null,
    totalTokensUsed: 42,
    totalCostUsd: 0.123,
    startedAt: new Date('2026-05-01T12:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-05-01T11:59:55Z'),
    executionTrace: [
      {
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Load models',
        status: 'completed',
        output: { ok: true },
        tokensUsed: 10,
        costUsd: 0.01,
        startedAt: '2026-05-01T12:00:00Z',
        completedAt: '2026-05-01T12:00:04Z',
        durationMs: 4000,
      },
    ],
    ...overrides,
  };
}

function makeRunningStepRow(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 'step-2',
    label: 'Analyse models',
    stepType: 'llm_call',
    startedAt: new Date('2026-05-01T12:00:05Z'),
    // Default `turns: null` — single-shot steps and freshly-started
    // multi-turn steps both surface as turnCount: 0 in the response.
    turns: null,
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/live`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('GET /api/v1/admin/orchestration/executions/:id/live', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid CUID param', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeRequest(), makeParams(INVALID_ID));
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(429);
  });

  it('returns 404 when execution not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns 404 when execution belongs to a different user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecutionRow({ userId: OTHER_USER_ID }) as never
    );
    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(404);
  });

  it('returns snapshot + trace + currentRunningSteps for a running execution', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeRunningStepRow(),
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{
      success: boolean;
      data: {
        snapshot: Record<string, unknown>;
        trace: unknown[];
        costEntries: unknown[];
        currentRunningSteps: Array<Record<string, unknown>>;
      };
    }>(response);

    expect(body.success).toBe(true);
    expect(body.data.snapshot).toEqual({
      id: EXECUTION_ID,
      status: 'running',
      currentStep: 'step-2',
      errorMessage: null,
      totalTokensUsed: 42,
      totalCostUsd: 0.123,
      startedAt: '2026-05-01T12:00:00.000Z',
      completedAt: null,
      createdAt: '2026-05-01T11:59:55.000Z',
    });
    expect(body.data.trace).toHaveLength(1);
    expect(body.data.currentRunningSteps).toEqual([
      {
        stepId: 'step-2',
        label: 'Analyse models',
        stepType: 'llm_call',
        startedAt: '2026-05-01T12:00:05.000Z',
        turnCount: 0,
      },
    ]);
  });

  it('exposes turnCount from running-step `turns` length so long agent_calls show forward progress', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeRunningStepRow({
        stepId: 'discover_new_models',
        label: 'Discover new models',
        stepType: 'agent_call',
        turns: Array.from({ length: 7 }, (_, i) => ({
          kind: 'agent_call',
          phase: 'continuing',
          index: i,
        })),
      }),
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: { currentRunningSteps: Array<{ turnCount: number }> } }>(
      response
    );

    expect(body.data.currentRunningSteps[0]?.turnCount).toBe(7);
  });

  it('returns turnCount=0 when running-step has no turns persisted yet', async () => {
    // Either the executor doesn't use `recordTurn` (single-shot) or the
    // step just started and hasn't fired its first turn yet. Either way
    // the UI should treat it as "no progress signal" and hide the chip.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeRunningStepRow({ turns: null }),
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: { currentRunningSteps: Array<{ turnCount: number }> } }>(
      response
    );

    expect(body.data.currentRunningSteps[0]?.turnCount).toBe(0);
  });

  it('returns empty currentRunningSteps when status is terminal', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(
      makeExecutionRow({ status: 'completed' }) as never
    );
    // Even if rows happen to linger (engine sweep race), terminal status
    // short-circuits the findMany and returns an empty array.
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeRunningStepRow(),
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: { currentRunningSteps: unknown[] } }>(response);

    expect(body.data.currentRunningSteps).toEqual([]);
    expect(vi.mocked(prisma.aiWorkflowRunningStep.findMany)).not.toHaveBeenCalled();
  });

  it('returns currentRunningSteps with one entry per branch during a parallel fan-out', async () => {
    // The headline behaviour: every in-flight branch surfaces as its own
    // running-step row instead of last-writer-wins on scalar columns.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeRunningStepRow({
        stepId: 'analyse_chat',
        label: 'Analyse chat',
        startedAt: new Date('2026-05-01T12:00:05Z'),
      }),
      makeRunningStepRow({
        stepId: 'analyse_embedding',
        label: 'Analyse embedding',
        startedAt: new Date('2026-05-01T12:00:05Z'),
      }),
      makeRunningStepRow({
        stepId: 'discover_new_models',
        label: 'Discover new models',
        startedAt: new Date('2026-05-01T12:00:05Z'),
      }),
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{
      data: { currentRunningSteps: Array<{ stepId: string }> };
    }>(response);

    expect(body.data.currentRunningSteps).toHaveLength(3);
    expect(body.data.currentRunningSteps.map((r) => r.stepId)).toEqual([
      'analyse_chat',
      'analyse_embedding',
      'discover_new_models',
    ]);
  });

  it('attributes cost-log rows by stepId; drops rows without a stepId', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);
    vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([
      {
        model: 'gpt-5',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0.05,
        operation: 'chat',
        metadata: { stepId: 'step-1' },
        createdAt: new Date('2026-05-01T12:00:02Z'),
      },
      {
        // No stepId — dropped.
        model: 'gpt-5',
        provider: 'openai',
        inputTokens: 5,
        outputTokens: 3,
        totalCostUsd: 0.001,
        operation: 'chat',
        metadata: null,
        createdAt: new Date('2026-05-01T12:00:03Z'),
      },
    ] as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: { costEntries: Array<{ stepId: string }> } }>(response);

    expect(body.data.costEntries).toHaveLength(1);
    expect(body.data.costEntries[0].stepId).toBe('step-1');
  });

  it('does not leak userId or raw executionTrace JSON', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(makeExecutionRow() as never);

    const response = await GET(makeRequest(), makeParams(EXECUTION_ID));
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    expect(body.data).not.toHaveProperty('userId');
    expect(body.data).not.toHaveProperty('executionTrace');
    // `trace` is the parsed view — the raw `executionTrace` key must not appear.
  });
});
