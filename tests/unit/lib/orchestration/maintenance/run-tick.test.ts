// @vitest-environment happy-dom

/**
 * Tests for `lib/orchestration/maintenance/run-tick.ts` — the tenant-scope
 * wiring of the maintenance tick (§108 t-711).
 *
 * The tick has two entries the registries do not cover: the awaited schedules
 * sweep and the idle-gate horizon. The first must run per org (a due
 * schedule's execution, and everything the engine writes for it, carries the
 * schedule's org); the second is the one genuinely global read in the tick
 * and must run under the audited system scope. Both must ignore whatever org
 * the caller entered — the admin route's guard enters the admin's org before
 * the tick runs, and before §108 every job inherited it.
 *
 * The tenancy primitives are real (env and the `Org` read mocked); the two
 * registries are mocked because their own scoping is tested in their own
 * files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockOrgFindMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { org: { findMany: mockOrgFindMany } } }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  processDueSchedules: vi.fn(),
  getNextScheduleRunAt: vi.fn(),
}));
vi.mock('@/lib/orchestration/maintenance/platform-jobs', () => ({
  PLATFORM_JOB_NAMES: ['a', 'b'],
  runDuePlatformJobs: vi.fn(),
}));
vi.mock('@/lib/orchestration/maintenance/app-jobs', () => ({
  runDueAppJobs: vi.fn(),
  getAppJobsMinIntervalMs: vi.fn(),
}));

import { logger } from '@/lib/logging';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import { processDueSchedules, getNextScheduleRunAt } from '@/lib/orchestration/scheduling';
import { runDuePlatformJobs } from '@/lib/orchestration/maintenance/platform-jobs';
import { runDueAppJobs, getAppJobsMinIntervalMs } from '@/lib/orchestration/maintenance/app-jobs';
import { __resetIdleGateForTests } from '@/lib/orchestration/maintenance/idle-gate';
import {
  runMaintenanceTick,
  __test_setTickRunning,
} from '@/lib/orchestration/maintenance/run-tick';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

const IDLE_SCHEDULES = { processed: 0, succeeded: 0, failed: 0, errors: [] };

/** The background chain is fire-and-forget; wait for its completion log line. */
async function backgroundChainDone(): Promise<void> {
  await vi.waitFor(() => {
    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.anything()
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetIdleGateForTests();
  __test_setTickRunning(false);
  mockEnv.TENANCY_MODE = 'single';
  mockOrgFindMany.mockResolvedValue([{ id: INSTALL_ORG_ID }]);
  vi.mocked(processDueSchedules).mockResolvedValue(IDLE_SCHEDULES);
  vi.mocked(getNextScheduleRunAt).mockResolvedValue(null);
  vi.mocked(runDuePlatformJobs).mockResolvedValue({ summary: {}, foundWork: false });
  vi.mocked(runDueAppJobs).mockResolvedValue(undefined);
  vi.mocked(getAppJobsMinIntervalMs).mockReturnValue(null);
});

describe('runMaintenanceTick — the schedules sweep', () => {
  it('at single runs once inside the install org and reports the sweep unchanged', async () => {
    const seen: Array<string | null | undefined> = [];
    vi.mocked(processDueSchedules).mockImplementation(async () => {
      seen.push(getTenantContext()?.orgId);
      return { ...IDLE_SCHEDULES, processed: 2, succeeded: 2 };
    });

    const result = await runMaintenanceTick();
    await backgroundChainDone();

    expect(seen).toEqual([INSTALL_ORG_ID]);
    expect(result.skipped).toBe(false);
    // Byte-identical at single: the route's `schedules` keeps its shape.
    expect(result.schedules).toEqual({ ...IDLE_SCHEDULES, processed: 2, succeeded: 2 });
  });

  it('at multi runs once per org, in that org, and folds the counters', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockOrgFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    const seen: Array<string | null | undefined> = [];
    vi.mocked(processDueSchedules).mockImplementation(async () => {
      const orgId = getTenantContext()?.orgId;
      seen.push(orgId);
      return {
        ...IDLE_SCHEDULES,
        processed: orgId === ORG_A ? 1 : 3,
        succeeded: orgId === ORG_A ? 1 : 2,
        failed: orgId === ORG_A ? 0 : 1,
        errors: orgId === ORG_A ? [] : [{ scheduleId: 's9', error: 'no version' }],
      };
    });

    const result = await runMaintenanceTick();
    await backgroundChainDone();

    expect(seen).toEqual([ORG_A, ORG_B]);
    expect(result.schedules).toEqual({
      orgs: 2,
      processed: 4,
      succeeded: 3,
      failed: 1,
      errors: [{ scheduleId: 's9', error: 'no version' }],
    });
  });

  it('ignores the org the caller entered — the admin route’s tick sweeps every org', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockOrgFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    const seen: Array<string | null | undefined> = [];
    vi.mocked(processDueSchedules).mockImplementation(async () => {
      seen.push(getTenantContext()?.orgId);
      return IDLE_SCHEDULES;
    });

    await runAsOrg('org_of_the_admin', () => runMaintenanceTick());
    await backgroundChainDone();

    expect(seen).toEqual([ORG_A, ORG_B]);
  });

  it('reports a sweep that throws for the only org as an error and leaves the gate disarmed', async () => {
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('schedules down'));

    const result = await runMaintenanceTick();
    await backgroundChainDone();

    expect(result.schedules).toEqual({ error: 'schedules down' });
    // Unknown state must not license skipping the next tick.
    expect(getNextScheduleRunAt).not.toHaveBeenCalled();
    const second = await runMaintenanceTick();
    expect(second.skipped).toBe(false);
  });

  it('at multi contains one org’s failure, runs the other, and still refuses to arm the gate', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockOrgFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    vi.mocked(processDueSchedules).mockImplementation(async () => {
      if (getTenantContext()?.orgId === ORG_A) throw new Error('A down');
      return IDLE_SCHEDULES;
    });

    const result = await runMaintenanceTick();
    await backgroundChainDone();

    expect(processDueSchedules).toHaveBeenCalledTimes(2);
    expect(result.schedules).toEqual({
      orgs: 2,
      ...IDLE_SCHEDULES,
      orgErrors: [{ orgId: ORG_A, error: 'A down' }],
    });
    expect(getNextScheduleRunAt).not.toHaveBeenCalled();
  });
});

describe('runMaintenanceTick — the idle-gate horizon', () => {
  it('reads the next run across all orgs under the audited system scope, only when arming', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockOrgFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);
    const seen: Array<string | null | undefined> = [];
    vi.mocked(getNextScheduleRunAt).mockImplementation(async () => {
      const ctx = getTenantContext();
      seen.push(ctx === null ? undefined : ctx.orgId);
      return new Date(Date.now() + 10 * 60 * 1000);
    });

    await runMaintenanceTick();
    await backgroundChainDone();

    // Exactly one read, in the system scope (`null` org), not once per org.
    expect(seen).toEqual([null]);
    expect(logger.info).toHaveBeenCalledWith('Entering system tenant scope', {
      reason: expect.stringContaining('idle-gate horizon'),
    });
    // And it armed: the next tick is skipped as idle.
    const next = await runMaintenanceTick();
    expect(next).toMatchObject({ skipped: true, reason: 'idle' });
  });

  it('does not read the horizon when the platform sweep found work', async () => {
    vi.mocked(runDuePlatformJobs).mockResolvedValue({ summary: { a: 1 }, foundWork: true });

    await runMaintenanceTick();
    await backgroundChainDone();

    expect(getNextScheduleRunAt).not.toHaveBeenCalled();
  });

  it('leaves the gate disarmed and warns when the horizon read fails', async () => {
    vi.mocked(getNextScheduleRunAt).mockRejectedValue(new Error('no horizon'));

    await runMaintenanceTick();
    await backgroundChainDone();

    expect(logger.warn).toHaveBeenCalledWith(
      'Maintenance tick: schedule horizon unavailable; leaving the idle gate disarmed',
      { error: 'no horizon' }
    );
    const next = await runMaintenanceTick();
    expect(next.skipped).toBe(false);
  });

  it('treats a rejecting platform registry as work, so the gate stays disarmed', async () => {
    vi.mocked(runDuePlatformJobs).mockRejectedValue(new Error('registry broke'));

    await runMaintenanceTick();
    await backgroundChainDone();

    expect(getNextScheduleRunAt).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({ error: 'Error: registry broke' })
    );
  });
});

describe('runMaintenanceTick — one org-list read per tick', () => {
  it('reads the active orgs once and hands the list to every per-org job', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockOrgFindMany.mockResolvedValue([{ id: ORG_A }, { id: ORG_B }]);

    await runMaintenanceTick();
    await backgroundChainDone();

    // Without the shared list each due job would read the same rows again —
    // the per-tick query count #442 exists to hold down.
    expect(mockOrgFindMany).toHaveBeenCalledTimes(1);
    expect(runDuePlatformJobs).toHaveBeenCalledWith(expect.any(Number), [ORG_A, ORG_B]);
    expect(runDueAppJobs).toHaveBeenCalledWith(expect.any(Number), [ORG_A, ORG_B]);
  });

  it('falls back to each job reading the list when the org read fails', async () => {
    mockOrgFindMany.mockRejectedValue(new Error('org list unavailable'));

    const result = await runMaintenanceTick();
    await backgroundChainDone();

    expect(result.skipped).toBe(false);
    expect(runDuePlatformJobs).toHaveBeenCalledWith(expect.any(Number), undefined);
  });
});

describe('runMaintenanceTick — guards', () => {
  it('arms the watchdog before the awaited sweep, so a hung sweep cannot wedge the guard', async () => {
    // The guard is taken above the sweep. A watchdog armed AFTER it is never
    // armed at all when the sweep hangs, and `tickRunning` then stays true for
    // the life of the process — every later tick reporting "previous tick
    // still running" and maintenance stopping for good.
    vi.useFakeTimers();
    try {
      vi.mocked(processDueSchedules).mockImplementation(() => new Promise<never>(() => {}));

      void runMaintenanceTick();
      // Let the org read settle, then run past the watchdog's five minutes.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

      expect(logger.warn).toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.objectContaining({ maxDurationMs: 5 * 60 * 1000 })
      );

      // And the guard really was released: the next tick is admitted.
      vi.mocked(processDueSchedules).mockResolvedValue(IDLE_SCHEDULES);
      const next = await runMaintenanceTick({ force: true });
      expect(next.skipped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips while a previous tick is still running', async () => {
    __test_setTickRunning(true);

    const result = await runMaintenanceTick();

    expect(result).toMatchObject({ skipped: true, reason: 'previous tick still running' });
    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  it('force sweeps through an armed idle gate', async () => {
    vi.mocked(getNextScheduleRunAt).mockResolvedValue(new Date(Date.now() + 10 * 60 * 1000));
    await runMaintenanceTick();
    await backgroundChainDone();
    vi.mocked(processDueSchedules).mockClear();

    const forced = await runMaintenanceTick({ force: true });

    expect(forced.skipped).toBe(false);
    expect(processDueSchedules).toHaveBeenCalledTimes(1);
  });

  it('folds a fork’s app-job summary into the completion line only when one exists', async () => {
    vi.mocked(runDueAppJobs).mockResolvedValue({ 'app:sweep': { n: 1 } });

    await runMaintenanceTick();
    await backgroundChainDone();

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({ appJobs: { 'app:sweep': { n: 1 } } })
    );
  });
});
