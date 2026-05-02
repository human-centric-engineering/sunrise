/**
 * Integration Test: Background workflow crash flow (end-to-end)
 *
 * Exercises the full chain from a single entry point so the assertions
 * across the chain agree:
 *
 *   processDueSchedules()        -- claim schedule, create execution
 *     └─> void drainEngine()
 *           └─> engine.execute() throws  (uncaught crash)
 *                 └─> drainEngine catch block:
 *                       1. prisma.aiWorkflowExecution.update -> status: 'failed'
 *                       2. emitHookEvent('workflow.execution.failed', ...)
 *
 *   GET /executions/:id/status   -- subscribers polling after the hook
 *                                   should see FAILED with errorMessage
 *
 * The unit tests cover each link in isolation; this test proves they
 * compose into a coherent observable state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    aiWorkflowExecution: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockExecute = vi.fn();
vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: class {
    execute = mockExecute;
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/validations/orchestration', () => ({
  workflowDefinitionSchema: {
    safeParse: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { processDueSchedules } from '@/lib/orchestration/scheduling/scheduler';
import { GET as GetStatus } from '@/app/api/v1/admin/orchestration/executions/[id]/status/route';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SCHEDULE_ID = 'sched_e2e_1';
const WORKFLOW_ID = 'wf_e2e_1';
const WORKFLOW_SLUG = 'crash-flow-wf';
const EXECUTION_ID = 'cmjbv4i3x00003wsloputgwul'; // valid CUID for status route
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul'; // matches execution.userId for ownership check

const VALID_DEFINITION = {
  steps: [{ id: 'step1', type: 'llm_call', config: {} }],
  entryStepId: 'step1',
  errorStrategy: 'fail',
};

interface StoredRow {
  id: string;
  workflowId: string;
  userId: string;
  status: string;
  inputData: unknown;
  executionTrace: unknown[];
  currentStep: string | null;
  errorMessage: string | null;
  totalTokensUsed: number;
  totalCostUsd: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('background workflow crash flow (e2e)', () => {
  let storedRow: StoredRow;

  beforeEach(() => {
    vi.clearAllMocks();

    storedRow = {
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      userId: ADMIN_ID,
      status: 'pending',
      inputData: { topic: 'test' },
      executionTrace: [],
      currentStep: null,
      errorMessage: null,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      startedAt: null,
      completedAt: null,
      createdAt: new Date('2026-05-01T11:00:00Z'),
    };

    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: true,
      data: VALID_DEFINITION,
    } as never);

    vi.mocked(prisma.aiWorkflowSchedule.updateMany).mockResolvedValue({ count: 1 });

    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(storedRow as never);

    // Update mutates our in-memory row so a later findUnique sees the new state.
    // Cast via `unknown` because Prisma's typed `update` signature is too tight
    // to mirror inside a test fixture — we only care about the shape we hand
    // back, not the exact `Prisma__AiWorkflowExecutionClient` machinery.
    type AnyMock = { mockImplementation: (impl: (...args: unknown[]) => unknown) => void };

    (prisma.aiWorkflowExecution.update as unknown as AnyMock).mockImplementation((...args) => {
      const { data } = args[0] as { data: Partial<StoredRow> };
      Object.assign(storedRow, data);
      return Promise.resolve(storedRow);
    });

    (prisma.aiWorkflowExecution.findUnique as unknown as AnyMock).mockImplementation(() =>
      Promise.resolve(storedRow)
    );

    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('engine crash repairs the row, emits the hook, and /status reports FAILED', async () => {
    // 1. Schedule is due
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      {
        id: SCHEDULE_ID,
        workflowId: WORKFLOW_ID,
        cronExpression: '0 9 * * *',
        inputTemplate: { topic: 'test' },
        isEnabled: true,
        lastRunAt: null,
        nextRunAt: new Date('2026-04-18T09:00:00Z'),
        createdBy: ADMIN_ID,
        workflow: {
          id: WORKFLOW_ID,
          slug: WORKFLOW_SLUG,
          isActive: true,
          workflowDefinition: VALID_DEFINITION,
        },
      },
    ] as never);

    // 2. Engine throws on first iteration
    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('engine internal failure');
      })()
    );

    // 3. Drive the scheduler — drainEngine fires fire-and-forget
    await processDueSchedules();

    // 4. Wait for the void drainEngine catch path to settle
    await vi.waitFor(() => {
      expect(emitHookEvent).toHaveBeenCalledWith('workflow.execution.failed', expect.any(Object));
    });

    // 5. The row should have been repaired in-place
    expect(storedRow.status).toBe('failed');
    expect(storedRow.errorMessage).toBe('engine internal failure');
    expect(storedRow.completedAt).toBeInstanceOf(Date);

    // 6. The hook payload should agree with the row
    const failureHookCall = vi
      .mocked(emitHookEvent)
      .mock.calls.find((c) => c[0] === 'workflow.execution.failed');
    expect(failureHookCall).toBeDefined();
    expect(failureHookCall![1]).toEqual({
      executionId: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowSlug: WORKFLOW_SLUG,
      userId: ADMIN_ID,
      error: 'engine internal failure',
    });

    // 6b. The webhook subscriptions subsystem should also receive the event so
    // admins who configured a webhook via the /admin/orchestration/webhooks UI
    // (instead of the API-only event hooks) get the same notification.
    expect(dispatchWebhookEvent).toHaveBeenCalledWith('execution_crashed', {
      executionId: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowSlug: WORKFLOW_SLUG,
      userId: ADMIN_ID,
      error: 'engine internal failure',
    });

    // 7. A subscriber polling /status after the hook fires sees the failed row
    const statusResponse = await GetStatus(
      new NextRequest(
        `http://localhost:3000/api/v1/admin/orchestration/executions/${EXECUTION_ID}/status`
      ),
      { params: Promise.resolve({ id: EXECUTION_ID }) }
    );

    expect(statusResponse.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { status: string; errorMessage: string | null; completedAt: string | null };
    }>(statusResponse);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('failed');
    expect(body.data.errorMessage).toBe('engine internal failure');
    expect(body.data.completedAt).not.toBeNull();
  });
});
