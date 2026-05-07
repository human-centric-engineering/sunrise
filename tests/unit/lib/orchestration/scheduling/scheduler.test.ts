/**
 * Tests for `lib/orchestration/scheduling/scheduler.ts`.
 *
 * Covers:
 *   - getNextRunAt: valid cron → future Date, invalid cron → null, custom base date
 *   - isValidCron: valid/invalid expressions
 *   - processDueSchedules: happy path, inactive workflow skip, optimistic lock,
 *     engine invocation, invalid workflow definition, execution creation failure
 *   - processPendingExecutions: recovery of stale pending rows, staleness threshold,
 *     inactive workflow handling, invalid definition handling
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    aiWorkflowExecution: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExecute = vi.fn().mockReturnValue((async function* () {})());
vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: class {
    execute = mockExecute;
  },
}));

vi.mock('@/lib/validations/orchestration', () => ({
  workflowDefinitionSchema: {
    safeParse: vi.fn().mockReturnValue({
      success: true,
      data: {
        steps: [{ id: 'step1', type: 'llm_call', config: {} }],
        entryStepId: 'step1',
        errorStrategy: 'fail',
      },
    }),
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  getNextRunAt,
  isValidCron,
  processDueSchedules,
  processPendingExecutions,
  resumeApprovedExecution,
  sanitiseHookErrorMessage,
} from '@/lib/orchestration/scheduling/scheduler';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_DEFINITION = {
  steps: [{ id: 'step1', type: 'llm_call', config: {} }],
  entryStepId: 'step1',
  errorStrategy: 'fail',
};

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched_1',
    workflowId: 'wf_1',
    name: 'Daily run',
    cronExpression: '0 9 * * *',
    inputTemplate: { topic: 'test' },
    isEnabled: true,
    lastRunAt: null,
    nextRunAt: new Date('2026-04-18T09:00:00Z'),
    createdBy: 'user_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    workflow: {
      id: 'wf_1',
      slug: 'test-workflow',
      isActive: true,
      publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
    },
    ...overrides,
  };
}

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec_1',
    workflowId: 'wf_1',
    versionId: 'wfv_1',
    status: 'pending',
    inputData: { topic: 'test' },
    executionTrace: [],
    userId: 'user_1',
    createdAt: new Date('2026-04-18T08:00:00Z'), // 1 hour ago — past staleness threshold
    workflow: {
      id: 'wf_1',
      slug: 'test-workflow',
      isActive: true,
      publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
    },
    version: { id: 'wfv_1', snapshot: VALID_DEFINITION },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('getNextRunAt', () => {
  it('returns a future Date for a valid cron expression', () => {
    const base = new Date();
    const next = getNextRunAt('* * * * *', base);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(base.getTime());
  });

  it('returns null for an invalid cron expression', () => {
    expect(getNextRunAt('not a cron')).toBeNull();
  });

  it('uses current time as default base', () => {
    const next = getNextRunAt('* * * * *');
    expect(next).toBeInstanceOf(Date);
    // Next minute should be within 60 seconds of now
    expect(next!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it('returns a date after the base for a daily schedule', () => {
    const base = new Date('2026-04-18T12:00:00Z');
    const next = getNextRunAt('30 14 * * *', base); // 14:30 daily
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(base.getTime());
  });
});

describe('isValidCron', () => {
  // test-review:accept tobe_true — boolean return from isValidCron; structural assertion on validator outcome
  it('returns true for valid cron expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
  });

  it('returns false for invalid cron expressions', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('60 25 * * *')).toBe(false);
  });
});

describe('sanitiseHookErrorMessage', () => {
  it('returns short messages unchanged when no paths are present', () => {
    expect(sanitiseHookErrorMessage('Boom')).toBe('Boom');
    expect(sanitiseHookErrorMessage('LLM timeout after 30s')).toBe('LLM timeout after 30s');
  });

  it('replaces POSIX absolute paths with <path>', () => {
    expect(sanitiseHookErrorMessage('Cannot read /Users/alice/code/sunrise/lib/foo.ts')).toBe(
      'Cannot read <path>'
    );
    expect(sanitiseHookErrorMessage('Error in /home/runner/work/repo/lib/x.ts at line 42')).toBe(
      'Error in <path> at line 42'
    );
  });

  it('replaces Windows absolute paths with <path>', () => {
    expect(sanitiseHookErrorMessage('Module not found: C:\\Users\\bob\\app\\lib\\db.ts')).toBe(
      'Module not found: <path>'
    );
  });

  it('truncates messages exceeding the max length', () => {
    const long = 'X'.repeat(500);
    const result = sanitiseHookErrorMessage(long);
    expect(result).toHaveLength(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate messages exactly at the max length boundary', () => {
    const exact = 'A'.repeat(200);
    expect(sanitiseHookErrorMessage(exact)).toBe(exact);
  });
});

describe('processDueSchedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: optimistic lock succeeds
    vi.mocked(prisma.aiWorkflowSchedule.updateMany).mockResolvedValue({ count: 1 });
    // Default: valid definition
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: true,
      data: VALID_DEFINITION,
    } as never);
    // Reset the execute mock to return a fresh iterator each time
    mockExecute.mockReturnValue((async function* () {})());
  });

  it('returns zeros when no schedules are due', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([]);

    const result = await processDueSchedules();

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, errors: [] });
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('creates execution and updates schedule via optimistic lock', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec_1' } as never);

    const result = await processDueSchedules();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // Verify optimistic lock — updateMany with original nextRunAt in WHERE
    expect(prisma.aiWorkflowSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 'sched_1', nextRunAt: schedule.nextRunAt },
      data: expect.objectContaining({
        lastRunAt: expect.any(Date),
        nextRunAt: expect.any(Date),
      }),
    });

    // Verify execution was created with WorkflowStatus constant
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: 'wf_1',
        status: 'pending',
        inputData: { topic: 'test' },
        executionTrace: [],
        userId: 'user_1',
      }),
    });
  });

  it('skips schedule when optimistic lock fails (already claimed)', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowSchedule.updateMany).mockResolvedValue({ count: 0 });

    const result = await processDueSchedules();

    // processed is decremented when lock fails
    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Scheduler: schedule already claimed by another tick, skipping',
      expect.objectContaining({ scheduleId: 'sched_1' })
    );
  });

  it('skips inactive workflows without creating execution', async () => {
    const schedule = makeSchedule({
      workflow: {
        id: 'wf_1',
        slug: 'inactive-wf',
        isActive: false,
        publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
      },
    });
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);

    const result = await processDueSchedules();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Scheduler: skipping schedule for inactive workflow',
      expect.objectContaining({ scheduleId: 'sched_1' })
    );
  });

  it('marks execution failed when workflow definition is invalid', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: {},
    } as never);
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: false,
      error: { issues: [{ message: 'bad' }] },
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);

    const result = await processDueSchedules();

    expect(result.failed).toBe(1);
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec_1' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'Invalid workflow definition',
      }),
    });
  });

  it('records failure when execution creation throws', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockRejectedValue(new Error('DB connection lost'));

    const result = await processDueSchedules();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ scheduleId: 'sched_1', error: 'DB connection lost' }]);
  });

  it('processes multiple schedules independently', async () => {
    const s1 = makeSchedule({ id: 'sched_1' });
    const s2 = makeSchedule({
      id: 'sched_2',
      nextRunAt: new Date('2026-04-18T10:00:00Z'),
      workflow: {
        id: 'wf_2',
        slug: 'wf-two',
        isActive: true,
        publishedVersion: { id: 'wfv_2', snapshot: VALID_DEFINITION },
      },
    });
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([s1, s2] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'e',
      inputData: {},
    } as never);

    const result = await processDueSchedules();

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledTimes(2);
  });

  it('uses inputTemplate as empty object when null', async () => {
    const schedule = makeSchedule({ inputTemplate: null });
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'e',
      inputData: {},
    } as never);

    await processDueSchedules();

    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputData: {},
      }),
    });
  });

  it('logs summary when schedules are processed', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'e',
      inputData: {},
    } as never);

    await processDueSchedules();

    expect(logger.info).toHaveBeenCalledWith(
      'Scheduler: tick complete',
      expect.objectContaining({ processed: 1, succeeded: 1, failed: 0 })
    );
  });

  it('does not log summary when no schedules are due', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([]);

    await processDueSchedules();

    expect(logger.info).not.toHaveBeenCalledWith('Scheduler: tick complete', expect.anything());
  });

  it('includes the published version snapshot in findMany select', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([]);

    await processDueSchedules();

    expect(prisma.aiWorkflowSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          workflow: {
            select: expect.objectContaining({
              publishedVersion: { select: { id: true, snapshot: true } },
            }),
          },
        },
      })
    );
  });

  it('records failure when the workflow has no published version (publish/draft model)', async () => {
    // A schedule pointing at a workflow that has never been published cannot
    // run — the scheduler must record a failure entry rather than create an
    // execution row pinned to a non-existent version.
    const schedule = makeSchedule({
      workflow: {
        id: 'wf_unpub',
        slug: 'unpublished-wf',
        isActive: true,
        publishedVersion: null,
      },
    });
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);

    const result = await processDueSchedules();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      { scheduleId: 'sched_1', error: 'Workflow has no published version' },
    ]);
    // No execution row should be inserted — bail before create.
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });
});

// ─── processPendingExecutions ───────────────────────────────────────────────

describe('processPendingExecutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: true,
      data: VALID_DEFINITION,
    } as never);
    mockExecute.mockReturnValue((async function* () {})());
  });

  it('returns zeros when no pending executions exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);

    const result = await processPendingExecutions();

    expect(result).toEqual({ recovered: 0, failed: 0, errors: [] });
  });

  it('marks execution failed when workflow is inactive', async () => {
    const exec = makeExecution({
      workflow: {
        id: 'wf_1',
        slug: 'inactive',
        isActive: false,
        publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
      },
    });
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec] as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);

    const result = await processPendingExecutions();

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec_1' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'Workflow deactivated',
      }),
    });
  });

  it('marks execution failed when workflow definition is invalid', async () => {
    const exec = makeExecution();
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec] as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: false,
      error: { issues: [{ message: 'bad' }] },
    } as never);

    const result = await processPendingExecutions();

    expect(result.failed).toBe(1);
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec_1' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'Invalid workflow definition',
      }),
    });
  });

  it('recovers valid pending executions by invoking engine', async () => {
    const exec = makeExecution();
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec] as never);

    const result = await processPendingExecutions();

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      'Scheduler: recovering pending execution',
      expect.objectContaining({ executionId: 'exec_1' })
    );
  });

  it('uses staleness threshold to filter by createdAt', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);

    await processPendingExecutions(5 * 60 * 1000); // 5 min threshold

    expect(prisma.aiWorkflowExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          createdAt: { lt: expect.any(Date) },
        }),
      })
    );
  });

  it('respects the take: 20 batch limit', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([]);

    await processPendingExecutions();

    expect(prisma.aiWorkflowExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });

  it('marks pending execution failed when neither pinned nor current version snapshot is available', async () => {
    // Edge case: the original pinned version row was hard-deleted AND the
    // workflow has no current published version. The recovery must mark the
    // row as FAILED rather than try to drain a missing definition.
    const exec = makeExecution({
      id: 'exec_orphan',
      versionId: null, // pinned version row is gone, FK SetNull → null
      version: null,
      workflow: {
        id: 'wf_1',
        slug: 'test-workflow',
        isActive: true,
        publishedVersion: null, // workflow has been un-published / never published
      },
    });
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec] as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);

    const result = await processPendingExecutions();

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec_orphan' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'No published version to resume',
      }),
    });
  });

  it('handles errors for individual executions without stopping the batch', async () => {
    const exec1 = makeExecution({ id: 'exec_1' });
    const exec2 = makeExecution({ id: 'exec_2' });
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec1, exec2] as never);

    // Make exec1's workflow definition check succeed but exec2 throw an unexpected error
    let callCount = 0;
    vi.mocked(workflowDefinitionSchema.safeParse).mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('Unexpected');
      return { success: true, data: VALID_DEFINITION } as never;
    });

    const result = await processPendingExecutions();

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({ executionId: 'exec_2', error: 'Unexpected' })
    );
  });
});

// ─── drainEngine crash path ─────────────────────────────────────────────────
//
// drainEngine is private and called via `void drainEngine(...)` from both
// processDueSchedules (line 193) and processPendingExecutions (line 295).
// We exercise it indirectly via those entry points and use vi.waitFor to
// observe side-effects that land after the entry point's promise resolves.

describe('drainEngine: engine crash path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWorkflowSchedule.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: true,
      data: VALID_DEFINITION,
    } as never);
  });

  it('marks execution FAILED and emits workflow.execution.failed when engine throws (scheduled path)', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: { topic: 'test' },
    } as never);

    // Engine throws on first iteration
    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('engine boom');
      })()
    );

    await processDueSchedules();

    await vi.waitFor(() => {
      expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec_1' },
        data: {
          status: 'failed',
          errorMessage: 'engine boom',
          completedAt: expect.any(Date),
        },
      });
      expect(emitHookEvent).toHaveBeenCalledWith('workflow.execution.failed', {
        executionId: 'exec_1',
        workflowId: 'wf_1',
        workflowSlug: 'test-workflow',
        userId: 'user_1',
        error: 'engine boom',
      });
      // Mirror to the webhook subscriptions subsystem so admins can subscribe
      // via the existing /admin/orchestration/webhooks UI.
      expect(dispatchWebhookEvent).toHaveBeenCalledWith('execution_crashed', {
        executionId: 'exec_1',
        workflowId: 'wf_1',
        workflowSlug: 'test-workflow',
        userId: 'user_1',
        error: 'engine boom',
      });
    });
  });

  it('logs but does not throw when dispatchWebhookEvent rejects after engine crash', async () => {
    // Exercises the `.catch(...)` arm on the dispatchWebhookEvent call inside
    // drainEngine (line ~153). The webhook dispatch is fire-and-forget; a
    // rejection should be logged at warn but never abort the crash-recovery
    // path or surface as an unhandled rejection.
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_dispatch_err',
      inputData: { topic: 'test' },
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockResolvedValue({} as never);
    vi.mocked(dispatchWebhookEvent).mockRejectedValue(new Error('Webhook DNS failure'));

    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('engine crashed');
      })()
    );

    await processDueSchedules();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Webhook dispatch failed for execution_crashed',
        expect.objectContaining({
          executionId: 'exec_dispatch_err',
          error: 'Webhook DNS failure',
        })
      );
    });
  });

  it('still emits workflow.execution.failed when the row update itself fails', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: { topic: 'test' },
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.update).mockRejectedValue(new Error('DB down'));

    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('engine boom');
      })()
    );

    await processDueSchedules();

    // Notification is not gated on row update success — reaper is the safety net.
    await vi.waitFor(() => {
      expect(emitHookEvent).toHaveBeenCalledWith(
        'workflow.execution.failed',
        expect.objectContaining({ executionId: 'exec_1', error: 'engine boom' })
      );
      expect(logger.error).toHaveBeenCalledWith(
        'Scheduler: failed to mark crashed execution as failed',
        expect.objectContaining({ executionId: 'exec_1', error: 'DB down' })
      );
    });
  });

  it('does not emit workflow.execution.failed when engine completes normally', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: { topic: 'test' },
    } as never);

    // Empty generator — for-await completes without throwing
    mockExecute.mockReturnValue((async function* () {})());

    await processDueSchedules();

    // Flush microtasks so the void drainEngine settles.
    await new Promise((resolve) => setImmediate(resolve));

    expect(emitHookEvent).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    // Catch-path row update only; the legitimate finalize() update is mocked
    // away because OrchestrationEngine itself is mocked. So no update call here.
    expect(prisma.aiWorkflowExecution.update).not.toHaveBeenCalled();
  });

  it('marks execution FAILED and emits hook when engine throws on recovery path', async () => {
    const exec = makeExecution({ id: 'exec_1' });
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([exec] as never);

    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('recovery boom');
      })()
    );

    await processPendingExecutions();

    await vi.waitFor(() => {
      expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec_1' },
        data: {
          status: 'failed',
          errorMessage: 'recovery boom',
          completedAt: expect.any(Date),
        },
      });
      expect(emitHookEvent).toHaveBeenCalledWith('workflow.execution.failed', {
        executionId: 'exec_1',
        workflowId: 'wf_1',
        workflowSlug: 'test-workflow',
        userId: 'user_1',
        error: 'recovery boom',
      });
    });
  });

  it('sanitises the hook payload error but persists the full message to the row (wiring proof)', async () => {
    const schedule = makeSchedule();
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([schedule] as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({
      id: 'exec_1',
      inputData: { topic: 'test' },
    } as never);

    // Error message contains an absolute path — the sanitiser MUST strip it
    // from the hook payload, but the DB row MUST retain the full message.
    const dirtyMessage = 'Cannot read /Users/alice/code/sunrise/lib/foo.ts at line 42';
    mockExecute.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error(dirtyMessage);
      })()
    );

    await processDueSchedules();

    await vi.waitFor(() => {
      expect(emitHookEvent).toHaveBeenCalledWith(
        'workflow.execution.failed',
        expect.objectContaining({ error: 'Cannot read <path> at line 42' })
      );
    });

    // DB row keeps the full unsanitised message — admins see the truth via
    // the admin UI / status endpoint.
    expect(prisma.aiWorkflowExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec_1' },
      data: expect.objectContaining({
        errorMessage: dirtyMessage,
      }),
    });
  });
});

// ─── resumeApprovedExecution ────────────────────────────────────────────────
//
// Channel-specific approval routes (chat, embed) call `resumeApprovedExecution`
// to drain the engine immediately after an HMAC-verified approval, so the
// user-facing card doesn't have to wait on the maintenance tick. The function
// has several short-circuit branches: missing execution, deactivated workflow,
// no pinned snapshot, malformed snapshot, and the happy path.

describe('resumeApprovedExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValue({
      success: true,
      data: VALID_DEFINITION,
    } as never);
    mockExecute.mockReturnValue((async function* () {})());
  });

  it('returns silently when the execution row is missing', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);

    await resumeApprovedExecution('exec_missing');

    // No engine call, no DB write — defensive early return.
    expect(mockExecute).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowExecution.update).not.toHaveBeenCalled();
  });

  it('marks the execution failed when the workflow has been deactivated', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_deact' }),
      workflow: {
        id: 'wf_1',
        slug: 'deactivated-wf',
        isActive: false,
        publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
      },
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockResolvedValue({ count: 1 } as never);

    await resumeApprovedExecution('exec_deact');

    expect(prisma.aiWorkflowExecution.updateMany).toHaveBeenCalledWith({
      where: { id: 'exec_deact', status: 'pending' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'Workflow deactivated',
      }),
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('logs but does not throw when mark-failed updateMany rejects on the deactivated path', async () => {
    // Exercises the `.catch(...)` arm on the inactive-workflow updateMany
    // (line ~392) — it logs to logger.error and swallows the rejection so
    // the caller's promise resolves cleanly.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_deact_err' }),
      workflow: {
        id: 'wf_1',
        slug: 'deactivated-wf',
        isActive: false,
        publishedVersion: { id: 'wfv_1', snapshot: VALID_DEFINITION },
      },
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.updateMany).mockRejectedValue(new Error('DB unreachable'));

    await expect(resumeApprovedExecution('exec_deact_err')).resolves.toBeUndefined();
    // Wait a tick for the promise rejection to propagate to the catch handler.
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.error).toHaveBeenCalledWith(
      'resumeApprovedExecution: mark-failed update failed',
      expect.any(Error),
      expect.objectContaining({ executionId: 'exec_deact_err' })
    );
  });

  it('logs and returns when neither pinned nor current snapshot is available', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_orphan', versionId: null }),
      version: null,
      workflow: {
        id: 'wf_1',
        slug: 'unpub',
        isActive: true,
        publishedVersion: null,
      },
    } as never);

    await resumeApprovedExecution('exec_orphan');

    expect(logger.error).toHaveBeenCalledWith(
      'resumeApprovedExecution: no version snapshot to resume',
      undefined,
      expect.objectContaining({ executionId: 'exec_orphan' })
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('logs and returns when the snapshot fails Zod parse', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_bad' }),
      workflow: {
        id: 'wf_1',
        slug: 'wf-bad-def',
        isActive: true,
        publishedVersion: { id: 'wfv_1', snapshot: { invalid: true } },
      },
    } as never);
    vi.mocked(workflowDefinitionSchema.safeParse).mockReturnValueOnce({
      success: false,
      error: { issues: [{ message: 'malformed' }] },
    } as never);

    await resumeApprovedExecution('exec_bad');

    expect(logger.error).toHaveBeenCalledWith(
      'resumeApprovedExecution: invalid workflow definition',
      undefined,
      expect.objectContaining({ executionId: 'exec_bad' })
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('happy path: drains the engine with the pinned snapshot from execution.version', async () => {
    // The pinned `execution.version.snapshot` should be preferred over the
    // workflow's current published version — this is the publish/draft model
    // promise (resume runs the version it started against).
    const pinnedSnapshot = { ...VALID_DEFINITION, entryStepId: 'pinned-entry' };
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_happy', versionId: 'wfv_pinned' }),
      version: { id: 'wfv_pinned', snapshot: pinnedSnapshot },
      workflow: {
        id: 'wf_1',
        slug: 'happy-wf',
        isActive: true,
        publishedVersion: { id: 'wfv_current', snapshot: VALID_DEFINITION },
      },
    } as never);

    await resumeApprovedExecution('exec_happy');

    // Two assertions:
    // 1. workflowDefinitionSchema.safeParse was called with the PINNED snapshot
    //    (not the current published one). This proves the precedence rule.
    // 2. The engine received the pinned versionId.
    expect(workflowDefinitionSchema.safeParse).toHaveBeenCalledWith(pinnedSnapshot);
    expect(mockExecute).toHaveBeenCalledOnce();
    const arg = mockExecute.mock.calls[0]?.[0] as { versionId?: string };
    expect(arg.versionId).toBe('wfv_pinned');
  });

  it('falls back to the workflows current published snapshot for legacy rows with versionId=null', async () => {
    // Pre-pinning rows have versionId=null (FK SetNull or never stamped).
    // Recovery should fall back to the workflow's current published snapshot
    // rather than refusing to resume — the alternative is leaving the row
    // stuck in PENDING forever.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...makeExecution({ id: 'exec_legacy', versionId: null }),
      version: null,
      workflow: {
        id: 'wf_1',
        slug: 'legacy-wf',
        isActive: true,
        publishedVersion: { id: 'wfv_current', snapshot: VALID_DEFINITION },
      },
    } as never);

    await resumeApprovedExecution('exec_legacy');

    expect(workflowDefinitionSchema.safeParse).toHaveBeenCalledWith(VALID_DEFINITION);
    expect(mockExecute).toHaveBeenCalledOnce();
    const arg = mockExecute.mock.calls[0]?.[0] as { versionId?: string };
    // engine receives the fallback versionId from the workflow's current published.
    expect(arg.versionId).toBe('wfv_current');
  });
});
