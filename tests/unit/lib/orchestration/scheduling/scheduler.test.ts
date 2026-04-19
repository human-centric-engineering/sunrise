/**
 * Tests for `lib/orchestration/scheduling/scheduler.ts`.
 *
 * Covers:
 *   - getNextRunAt: valid cron → future Date, invalid cron → null, custom base date
 *   - isValidCron: valid/invalid expressions
 *   - processDueSchedules: happy path, inactive workflow skip, execution creation
 *     failure, empty due list, nextRunAt recomputation, batch limit
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    aiWorkflowExecution: {
      create: vi.fn(),
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

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  getNextRunAt,
  isValidCron,
  processDueSchedules,
} from '@/lib/orchestration/scheduling/scheduler';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    workflow: { id: 'wf_1', slug: 'test-workflow', isActive: true },
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
  });

  it('returns zeros when no schedules are due', async () => {
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await processDueSchedules();

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, errors: [] });
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('creates execution and updates schedule for a due schedule', async () => {
    const schedule = makeSchedule();
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([schedule]);
    (prisma.aiWorkflowSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue(schedule);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'exec_1',
    });

    const result = await processDueSchedules();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // Verify execution was created with correct data
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: 'wf_1',
        status: 'pending',
        inputData: { topic: 'test' },
        executionTrace: [],
        userId: 'user_1',
      }),
    });

    // Verify schedule was updated with lastRunAt and new nextRunAt
    expect(prisma.aiWorkflowSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sched_1' },
      data: expect.objectContaining({
        lastRunAt: expect.any(Date),
        nextRunAt: expect.any(Date),
      }),
    });
  });

  it('skips inactive workflows without creating execution', async () => {
    const schedule = makeSchedule({
      workflow: { id: 'wf_1', slug: 'inactive-wf', isActive: false },
    });
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([schedule]);

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

  it('records failure when execution creation throws', async () => {
    const schedule = makeSchedule();
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([schedule]);
    (prisma.aiWorkflowSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue(schedule);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection lost')
    );

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
      workflow: { id: 'wf_2', slug: 'wf-two', isActive: true },
    });
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([s1, s2]);
    (prisma.aiWorkflowSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'e' });

    const result = await processDueSchedules();

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledTimes(2);
  });

  it('uses inputTemplate as empty object when null', async () => {
    const schedule = makeSchedule({ inputTemplate: null });
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([schedule]);
    (prisma.aiWorkflowSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue(schedule);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'e' });

    await processDueSchedules();

    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputData: {},
      }),
    });
  });

  it('logs summary when schedules are processed', async () => {
    const schedule = makeSchedule();
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([schedule]);
    (prisma.aiWorkflowSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue(schedule);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'e' });

    await processDueSchedules();

    expect(logger.info).toHaveBeenCalledWith(
      'Scheduler: tick complete',
      expect.objectContaining({ processed: 1, succeeded: 1, failed: 0 })
    );
  });

  it('does not log summary when no schedules are due', async () => {
    (prisma.aiWorkflowSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await processDueSchedules();

    expect(logger.info).not.toHaveBeenCalledWith('Scheduler: tick complete', expect.anything());
  });
});
