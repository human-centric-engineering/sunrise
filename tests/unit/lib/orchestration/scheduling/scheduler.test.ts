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
      findMany: vi.fn(),
      update: vi.fn(),
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

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  getNextRunAt,
  isValidCron,
  processDueSchedules,
  processPendingExecutions,
} from '@/lib/orchestration/scheduling/scheduler';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

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
      workflowDefinition: VALID_DEFINITION,
    },
    ...overrides,
  };
}

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec_1',
    workflowId: 'wf_1',
    status: 'pending',
    inputData: { topic: 'test' },
    executionTrace: [],
    userId: 'user_1',
    createdAt: new Date('2026-04-18T08:00:00Z'), // 1 hour ago — past staleness threshold
    workflow: {
      id: 'wf_1',
      slug: 'test-workflow',
      isActive: true,
      workflowDefinition: VALID_DEFINITION,
    },
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
        workflowDefinition: VALID_DEFINITION,
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
        workflowDefinition: VALID_DEFINITION,
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

  it('includes workflowDefinition in findMany select', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([]);

    await processDueSchedules();

    expect(prisma.aiWorkflowSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          workflow: {
            select: expect.objectContaining({ workflowDefinition: true }),
          },
        },
      })
    );
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
        workflowDefinition: VALID_DEFINITION,
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
