/**
 * Unit tests: Admin Orchestration — Executions list
 *
 * GET /api/v1/admin/orchestration/executions
 *
 * Covers:
 *   - Standard auth/rate-limit paths (401 / 403 / 429 / 200)
 *   - timeInCurrentStepMs computation for all combinations of running
 *     vs completed rows and step presence:
 *     A. All completed → step findMany NOT called, timeInCurrentStepMs null
 *     B. Running row with a step → computed age (frozen clock, exact)
 *     C. Running row, no step row → timeInCurrentStepMs null
 *     D. Parallel fan-out: multiple step rows reduce to oldest
 *     E. Mixed page: running item computed, completed item null
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mocks (must precede imports that load the mocked modules) ───────────────

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
    aiWorkflowRunningStep: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(() => new Response(null, { status: 429 })),
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

// ─── Imports (after vi.mock calls) ──────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { GET } from '@/app/api/v1/admin/orchestration/executions/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const WORKFLOW_ID = 'wf-1';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    userId: ADMIN_ID,
    workflowId: WORKFLOW_ID,
    status: 'completed',
    totalTokensUsed: 0,
    totalCostUsd: 0,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Test setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
  vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions', () => {
  // ── Standard auth / rate-limit paths ───────────────────────────────────────

  describe('Authentication and authorization', () => {
    it('returns 401 when the request carries no session', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when the session belongs to a non-admin user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when the rate limiter rejects the request', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 100,
        remaining: 0,
        reset: Date.now() + 60_000,
      });

      const response = await GET(makeRequest());

      expect(response.status).toBe(429);
      expect(createRateLimitResponse).toHaveBeenCalledOnce();
    });

    it('returns 200 when the rate limiter allows the request through', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: true,
        limit: 100,
        remaining: 99,
        reset: Date.now() + 60_000,
      });

      const response = await GET(makeRequest());

      expect(response.status).toBe(200);
    });
  });

  // ── A: all-completed page ──────────────────────────────────────────────────

  describe('A — all completed rows: step findMany skipped, timeInCurrentStepMs null', () => {
    it('does not call aiWorkflowRunningStep.findMany when no executions are running', async () => {
      // Arrange: two completed rows — runningIds will be empty
      const executions = [
        makeExecution({ id: 'exec-1', status: 'completed' }),
        makeExecution({ id: 'exec-2', status: 'completed' }),
      ];
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue(executions as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(2);

      // Act
      await GET(makeRequest());

      // Assert: the route must not query running steps when there are no running executions
      expect(prisma.aiWorkflowRunningStep.findMany).not.toHaveBeenCalled();
    });

    it('sets timeInCurrentStepMs to null on every completed row', async () => {
      // Arrange
      const executions = [
        makeExecution({ id: 'exec-1', status: 'completed' }),
        makeExecution({ id: 'exec-2', status: 'failed' }),
      ];
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue(executions as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(2);

      // Act
      const response = await GET(makeRequest());
      const body = await parseJson<{ data: Array<{ id: string; timeInCurrentStepMs: unknown }> }>(
        response
      );

      // Assert: route must add the field and set it to null for non-running rows
      expect(body.data).toHaveLength(2);
      for (const item of body.data) {
        expect(item.timeInCurrentStepMs).toBeNull();
      }
    });
  });

  // ── B: running row with a step row ────────────────────────────────────────

  describe('B — running row with a step: timeInCurrentStepMs equals elapsed time', () => {
    it('computes the elapsed ms from the step startedAt to now (frozen clock)', async () => {
      // Arrange: freeze time so the assertion is exact
      const frozenNow = new Date('2026-05-20T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow);

      const stepStart = new Date(frozenNow.getTime() - 60_000); // 60 s ago
      const runningExec = makeExecution({ id: 'exec-1', status: 'running' });

      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([runningExec] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
        { executionId: 'exec-1', startedAt: stepStart },
      ] as never);

      // Act
      const response = await GET(makeRequest());
      const body = await parseJson<{ data: Array<{ timeInCurrentStepMs: number }> }>(response);

      // Assert: route computes now - startedAt, not just passing the mock value through
      expect(body.data[0].timeInCurrentStepMs).toBe(60_000);
    });
  });

  // ── C: running row but no step row ────────────────────────────────────────

  describe('C — running row with no matching step row: timeInCurrentStepMs null', () => {
    it('returns null when step findMany returns an empty array for a running execution', async () => {
      // Arrange
      const runningExec = makeExecution({ id: 'exec-1', status: 'running' });
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([runningExec] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);
      // Step query returns nothing — no in-flight step recorded yet
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);

      // Act
      const response = await GET(makeRequest());
      const body = await parseJson<{ data: Array<{ timeInCurrentStepMs: unknown }> }>(response);

      // Assert: route must not error and must emit null for the missing step
      expect(body.data[0].timeInCurrentStepMs).toBeNull();
    });

    it('calls aiWorkflowRunningStep.findMany with the running execution id', async () => {
      // Arrange
      const runningExec = makeExecution({ id: 'exec-1', status: 'running' });
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([runningExec] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);

      // Act
      await GET(makeRequest());

      // Assert: route queries steps only for the running execution id
      expect(prisma.aiWorkflowRunningStep.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            executionId: { in: ['exec-1'] },
            completedAt: null,
          }),
        })
      );
    });
  });

  // ── D: parallel fan-out — multiple step rows per execution ────────────────

  describe('D — parallel fan-out: oldest step startedAt wins', () => {
    it('uses the earliest startedAt when multiple step rows exist for one execution', async () => {
      // Arrange
      const frozenNow = new Date('2026-05-20T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow);

      const olderStart = new Date(frozenNow.getTime() - 60_000); // 60 s ago
      const newerStart = new Date(frozenNow.getTime() - 10_000); // 10 s ago

      const runningExec = makeExecution({ id: 'exec-1', status: 'running' });
      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([runningExec] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(1);
      // Two parallel branches — one started 10 s ago, one 60 s ago
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
        { executionId: 'exec-1', startedAt: newerStart },
        { executionId: 'exec-1', startedAt: olderStart },
      ] as never);

      // Act
      const response = await GET(makeRequest());
      const body = await parseJson<{ data: Array<{ timeInCurrentStepMs: number }> }>(response);

      // Assert: route must reduce to oldest start, reflecting "how long stuck" rather
      // than just the freshest branch
      expect(body.data[0].timeInCurrentStepMs).toBe(60_000);
    });
  });

  // ── E: mixed page — one running, one completed ───────────────────────────

  describe('E — mixed page: running item gets computed ms, completed item gets null', () => {
    it('assigns timeInCurrentStepMs only for the running row', async () => {
      // Arrange
      const frozenNow = new Date('2026-05-20T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow);

      const stepStart = new Date(frozenNow.getTime() - 45_000); // 45 s ago

      const runningExec = makeExecution({ id: 'exec-running', status: 'running' });
      const completedExec = makeExecution({ id: 'exec-done', status: 'completed' });

      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
        runningExec,
        completedExec,
      ] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(2);
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
        { executionId: 'exec-running', startedAt: stepStart },
      ] as never);

      // Act
      const response = await GET(makeRequest());
      const body = await parseJson<{
        data: Array<{ id: string; timeInCurrentStepMs: number | null }>;
      }>(response);

      // Assert: route transforms data differently per row — not a pass-through
      const runningItem = body.data.find((d) => d.id === 'exec-running');
      const completedItem = body.data.find((d) => d.id === 'exec-done');

      expect(runningItem?.timeInCurrentStepMs).toBe(45_000);
      expect(completedItem?.timeInCurrentStepMs).toBeNull();
    });

    it('passes only the running execution id in the step query where clause', async () => {
      // Arrange
      const runningExec = makeExecution({ id: 'exec-running', status: 'running' });
      const completedExec = makeExecution({ id: 'exec-done', status: 'completed' });

      vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([
        runningExec,
        completedExec,
      ] as never);
      vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(2);
      vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);

      // Act
      await GET(makeRequest());

      // Assert: route must not include the completed id in the IN clause
      expect(prisma.aiWorkflowRunningStep.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            executionId: { in: ['exec-running'] },
          }),
        })
      );
    });
  });
});
