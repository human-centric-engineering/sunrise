/**
 * Unit Test: Hook + webhook event emission on approval pause
 *
 * Verifies that `pauseForApproval()` in the orchestration engine emits both
 * `emitHookEvent('workflow.paused_for_approval', ...)` and
 * `dispatchWebhookEvent('approval_required', ...)` with correct payloads.
 *
 * @see lib/orchestration/engine/orchestration-engine.ts — pauseForApproval()
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (declared before the engine import) ──────────────────────────────

// A pause naming people runs in a transaction under erasure's lock (t-841).
// The real `findErasedSubjects` runs against `tx`; the paused-row write goes
// through the same `updateMany` mock either way.
const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  // Every write of a run also asks for erasures since it started (t-843): none.
  $queryRaw: vi.fn().mockResolvedValue([]),
  dataErasureReceipt: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => {
  const aiWorkflowExecution = {
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn(),
  };
  return {
    prisma: {
      aiWorkflowExecution,
      $transaction: vi.fn((run: (client: unknown) => Promise<unknown>) =>
        run({ ...tx, aiWorkflowExecution })
      ),
    },
  };
});

// `after()` records what it was handed (t-903); the real one throws outside a
// request scope.
const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: 'https://app.example.com',
  },
}));

vi.mock('@/lib/orchestration/engine/lease', () => ({
  claimLease: vi.fn(),
  generateLeaseToken: vi.fn().mockReturnValue('lease-token-test'),
  leaseExpiry: vi.fn().mockReturnValue(new Date()),
  startHeartbeat: vi.fn().mockReturnValue(vi.fn()),
  recordReleaseEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { PausedForApproval } from '@/lib/orchestration/engine/errors';
import { claimLease, startHeartbeat } from '@/lib/orchestration/engine/lease';
import { prisma } from '@/lib/db/client';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { subjectEmailHash } from '@/lib/privacy/erased-subjects';
import type { ExecutionEvent, WorkflowDefinition } from '@/types/orchestration';

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user_test';
const WORKFLOW_ID = 'wf_test';

function makeWorkflow(definition: WorkflowDefinition) {
  return { id: WORKFLOW_ID, definition };
}

function approvalDefinition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: 'gate',
        name: 'Approval Gate',
        type: 'human_approval',
        config: { prompt: 'Please approve' },
        nextSteps: [],
      },
    ],
    entryStepId: 'gate',
    errorStrategy: 'fail',
  };
}

async function collect(
  engine: OrchestrationEngine,
  wf: ReturnType<typeof makeWorkflow>,
  opts: Parameters<OrchestrationEngine['execute']>[2] = { userId: USER_ID }
) {
  const events: ExecutionEvent[] = [];
  for await (const e of engine.execute(wf, {}, opts)) events.push(e);
  return events;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('pauseForApproval event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRegistryForTests();

    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: 'exec_test',
      status: 'running',
    } as never);

    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_test',
      workflowId: WORKFLOW_ID,
      userId: USER_ID,
      status: 'running',
      inputData: {},
      executionTrace: [],
      totalTokensUsed: 0,
      totalCostUsd: 0,
      defaultErrorStrategy: 'fail',
      budgetLimitUsd: null,
      currentStep: null,
      startedAt: new Date(),
      completedAt: null,
      outputData: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    // Engine helpers use updateMany. Default count=1 — lease-loss path stays inactive.
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 });

    // Lease module — fresh stop function per test so heartbeat timer leaks don't
    // accumulate across tests. claimLease is only used on resume; not exercised here.
    vi.mocked(claimLease).mockResolvedValue('lease-token-test');
    vi.mocked(startHeartbeat).mockReturnValue(vi.fn());

    tx.$executeRaw.mockResolvedValue(1);
    tx.dataErasureReceipt.findMany.mockResolvedValue([]);
    tx.user.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    __resetRegistryForTests();
  });

  it('emits workflow.paused_for_approval hook event with correct payload', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, {
        prompt: 'Please approve this',
        notificationChannel: 'slack',
        timeoutMinutes: 60,
      });
    });

    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    expect(emitHookEvent).toHaveBeenCalledWith(
      'workflow.paused_for_approval',
      expect.objectContaining({
        executionId: 'exec_test',
        workflowId: WORKFLOW_ID,
        userId: USER_ID,
        stepId: 'gate',
        prompt: 'Please approve this',
        notificationChannel: { type: 'slack' },
        timeoutMinutes: 60,
        approveUrl: expect.stringContaining(
          '/api/v1/orchestration/approvals/exec_test/approve?token='
        ),
        rejectUrl: expect.stringContaining(
          '/api/v1/orchestration/approvals/exec_test/reject?token='
        ),
        tokenExpiresAt: expect.any(String),
      })
    );
  });

  it('keeps the approval_required dispatch alive past the run: after() holds it until it settles (t-903)', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'Please approve' });
    });
    let finishDispatch!: () => void;
    vi.mocked(dispatchWebhookEvent).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDispatch = resolve;
      })
    );

    // The run pauses and its event stream ends while the dispatch is still open.
    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    let settled = false;
    void handed.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(dispatchWebhookEvent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finishDispatch();
    await handed;
    expect(settled).toBe(true);
  });

  it('dispatches approval_required webhook event with correct payload', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, {
        prompt: 'Review required',
        notificationChannel: 'email',
        timeoutMinutes: 120,
      });
    });

    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      'approval_required',
      expect.objectContaining({
        executionId: 'exec_test',
        workflowId: WORKFLOW_ID,
        userId: USER_ID,
        stepId: 'gate',
        prompt: 'Review required',
        notificationChannel: { type: 'email' },
        timeoutMinutes: 120,
        approveUrl: expect.stringContaining('token='),
        rejectUrl: expect.stringContaining('token='),
      })
    );
  });

  it('includes undefined fields when approval payload omits optional values', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'Quick approve' });
    });

    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    expect(emitHookEvent).toHaveBeenCalledWith(
      'workflow.paused_for_approval',
      expect.objectContaining({
        executionId: 'exec_test',
        stepId: 'gate',
        prompt: 'Quick approve',
      })
    );
  });

  it('does not emit events when DB update fails', async () => {
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (args: unknown) => {
      const { data } = args as { data: Record<string, unknown> };
      if (data.status === 'paused_for_approval') {
        throw new Error('DB connection lost');
      }
      return { count: 1 };
    }) as never);

    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'approve' });
    });

    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    expect(emitHookEvent).not.toHaveBeenCalledWith(
      'workflow.paused_for_approval',
      expect.anything()
    );
    expect(dispatchWebhookEvent).not.toHaveBeenCalledWith('approval_required', expect.anything());
  });

  it('both hook and webhook are emitted in a single pause', async () => {
    registerStepType('human_approval', async (step) => {
      throw new PausedForApproval(step.id, { prompt: 'dual emit' });
    });

    await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

    // Both should fire exactly once
    const hookCalls = vi
      .mocked(emitHookEvent)
      .mock.calls.filter(([type]) => type === 'workflow.paused_for_approval');
    const webhookCalls = vi
      .mocked(dispatchWebhookEvent)
      .mock.calls.filter(([type]) => type === 'approval_required');

    expect(hookCalls).toHaveLength(1);
    expect(webhookCalls).toHaveLength(1);
  });

  // ── People erased while the run was in flight (t-841) ─────────────────────

  describe('a person erased since the run started', () => {
    const named = {
      approverUserIds: ['gone-user', 'kept-user'],
      notificationChannel: { type: 'email', target: 'Gone@Example.com' },
    };

    function namingDefinition(): WorkflowDefinition {
      const definition = approvalDefinition();
      definition.steps[0].config = { prompt: 'Please approve', ...named };
      return definition;
    }

    beforeEach(() => {
      // Both erased: the id outright, the address as erasure matched it, verified.
      tx.dataErasureReceipt.findMany.mockResolvedValue([
        { subjectUserId: 'gone-user', subjectEmailHash: null, metadata: {} },
        {
          subjectUserId: 'other',
          subjectEmailHash: subjectEmailHash('gone@example.com'),
          metadata: { addressVerified: true },
        },
      ]);
      registerStepType('human_approval', async (step) => {
        throw new PausedForApproval(step.id, { prompt: 'Please approve', ...named });
      });
    });

    function pausedTrace(): Array<Record<string, unknown>> {
      const call = vi
        .mocked(prisma.aiWorkflowExecution.updateMany)
        .mock.calls.find(
          ([args]) => (args as { data: { status?: string } }).data.status === 'paused_for_approval'
        );
      if (!call) throw new Error('the paused row was never written');
      return (call[0] as { data: { executionTrace: Array<Record<string, unknown>> } }).data
        .executionTrace;
    }

    it('writes the paused row without them, in the trace entry the approval routes read', async () => {
      await collect(new OrchestrationEngine(), makeWorkflow(namingDefinition()));

      const entry = pausedTrace().find((e) => e.status === 'awaiting_approval');
      expect(entry?.output).toMatchObject({
        approverUserIds: ['kept-user'],
        notificationChannel: { type: 'email' },
      });
      expect(entry?.input).toMatchObject({
        approverUserIds: ['kept-user'],
        notificationChannel: { type: 'email' },
      });
      expect(JSON.stringify(entry)).not.toMatch(/gone-user|gone@example\.com/i);
    });

    it('sends neither of them in the hook, the webhook or the streamed event', async () => {
      const events = await collect(new OrchestrationEngine(), makeWorkflow(namingDefinition()));

      const hookPayload = vi
        .mocked(emitHookEvent)
        .mock.calls.find(([name]) => name === 'workflow.paused_for_approval')?.[1];
      expect(hookPayload).toMatchObject({
        approverUserIds: ['kept-user'],
        notificationChannel: { type: 'email' },
      });
      await vi.waitFor(() => expect(dispatchWebhookEvent).toHaveBeenCalled());
      const webhookPayload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1];
      const streamed = events.find((e) => e.type === 'approval_required');
      for (const payload of [hookPayload, webhookPayload, streamed]) {
        expect(JSON.stringify(payload)).not.toMatch(/gone-user|gone@example\.com/i);
      }
      expect(JSON.stringify(streamed)).toContain('kept-user');
    });

    it('checks under the lock, inside the transaction that writes the row', async () => {
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        if (strings.join('?').includes('pg_advisory_xact_lock')) order.push('lock');
        return 1;
      });
      vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation((async (
        args: unknown
      ) => {
        if ((args as { data: { status?: string } }).data.status === 'paused_for_approval') {
          order.push('write');
        }
        return { count: 1 };
      }) as never);

      await collect(new OrchestrationEngine(), makeWorkflow(namingDefinition()));

      expect(prisma.$transaction).toHaveBeenCalledOnce();
      // Shared: only an erasure, never another pause or send, must wait for it.
      const statements = tx.$executeRaw.mock.calls.map(([strings]) =>
        (strings as TemplateStringsArray).join('?')
      );
      expect(statements.filter((q) => q.includes('pg_advisory_xact_lock_shared('))).toHaveLength(3);
      // The lock-wait bound is lifted before the row write, which waits as before.
      const bounds = tx.$executeRaw.mock.calls
        .filter(([strings]) => (strings as TemplateStringsArray).join('?').includes('lock_timeout'))
        .map((call) => call[1]);
      expect(bounds).toEqual(['150000ms', '0ms']);
      // One lock per key it names: two approver ids and the address.
      expect(order).toEqual(['lock', 'lock', 'lock', 'write']);
    });

    it("redacts them elsewhere in the payload by erasure's run rule, as the run row is", async () => {
      registerStepType('human_approval', async (step) => {
        throw new PausedForApproval(step.id, {
          prompt: 'Please approve',
          previous: { to: 'gone@example.com' },
          ...named,
        });
      });

      await collect(new OrchestrationEngine(), makeWorkflow(namingDefinition()));

      const entry = pausedTrace().find((e) => e.status === 'awaiting_approval');
      expect(entry?.output).toMatchObject({ previous: { to: '[erased]' } });
      await vi.waitFor(() => expect(dispatchWebhookEvent).toHaveBeenCalled());
      const webhookPayload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1];
      expect(JSON.stringify(webhookPayload)).not.toMatch(/gone@example\.com/i);
    });

    it('takes no erasure lock for an approval that names nobody', async () => {
      registerStepType('human_approval', async (step) => {
        throw new PausedForApproval(step.id, { prompt: 'approve', notificationChannel: 'slack' });
      });

      await collect(new OrchestrationEngine(), makeWorkflow(approvalDefinition()));

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.dataErasureReceipt.findMany).not.toHaveBeenCalled();
    });
  });
});
