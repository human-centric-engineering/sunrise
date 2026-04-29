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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
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

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  __resetRegistryForTests,
  registerStepType,
} from '@/lib/orchestration/engine/executor-registry';
import { PausedForApproval } from '@/lib/orchestration/engine/errors';
import { prisma } from '@/lib/db/client';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
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

    vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async (args: unknown) => {
      const { where, data } = args as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      return { id: where.id, ...data };
    }) as never);
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
    vi.mocked(prisma.aiWorkflowExecution.update).mockImplementation((async (args: unknown) => {
      const { data } = args as { data: Record<string, unknown> };
      if (data.status === 'paused_for_approval') {
        throw new Error('DB connection lost');
      }
      return { id: 'exec_test', ...data };
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
});
