// @vitest-environment happy-dom

/**
 * Tests for `lib/orchestration/maintenance/platform-jobs.ts` (#442).
 *
 * The point of this table is that an idle tick stops doing database work it
 * cannot possibly benefit from. So the assertions that matter are: which tasks
 * are exempt from throttling (the retry drains — throttling them would miss a
 * 10s backoff), which are held back and for how long, and that a task failing
 * or hanging cannot take the rest of the sweep with it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  processOrphanedExecutions: vi.fn(),
  processPendingExecutions: vi.fn(),
}));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({ processPendingRetries: vi.fn() }));
vi.mock('@/lib/orchestration/hooks/registry', () => ({ processPendingHookRetries: vi.fn() }));
vi.mock('@/lib/orchestration/engine/execution-reaper', () => ({ reapZombieExecutions: vi.fn() }));
vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  backfillMissingEmbeddings: vi.fn(),
}));
vi.mock('@/lib/orchestration/retention', () => ({ enforceRetentionPolicies: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/run-worker', () => ({
  processPendingEvaluationRuns: vi.fn(),
}));

import { logger } from '@/lib/logging';
import {
  processOrphanedExecutions,
  processPendingExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';
import {
  PLATFORM_JOBS,
  PLATFORM_JOB_NAMES,
  THROTTLED,
  runDuePlatformJobs,
  __resetPlatformJobsForTests,
} from '@/lib/orchestration/maintenance/platform-jobs';

const MINUTE = 60 * 1000;
const T0 = 1_000_000;

const ALL_TASKS = [
  processPendingRetries,
  processPendingHookRetries,
  processOrphanedExecutions,
  reapZombieExecutions,
  backfillMissingEmbeddings,
  enforceRetentionPolicies,
  processPendingExecutions,
  processPendingEvaluationRuns,
];

const RETENTION_IDLE = {
  deleted: 0,
  agentsProcessed: 0,
  webhookDeliveriesDeleted: 0,
  hookDeliveriesDeleted: 0,
  costLogsDeleted: 0,
  auditLogsDeleted: 0,
  executionsDeleted: 0,
  evaluationSessionsDeleted: 0,
  evaluationRunsDeleted: 0,
  mcpAuditLogsDeleted: 0,
};

/** Every task reporting "nothing found" — the idle deployment this feature targets. */
function mockIdleTasks(): void {
  vi.mocked(processPendingRetries).mockResolvedValue(0);
  vi.mocked(processPendingHookRetries).mockResolvedValue(0);
  vi.mocked(processOrphanedExecutions).mockResolvedValue({
    recovered: 0,
    exhausted: 0,
    errors: [],
  });
  vi.mocked(reapZombieExecutions).mockResolvedValue({
    reaped: 0,
    stalePending: 0,
    abandonedApprovals: 0,
  });
  vi.mocked(backfillMissingEmbeddings).mockResolvedValue({ processed: 0, failed: 0 });
  vi.mocked(enforceRetentionPolicies).mockResolvedValue(RETENTION_IDLE);
  vi.mocked(processPendingExecutions).mockResolvedValue({ recovered: 0, failed: 0, errors: [] });
  vi.mocked(processPendingEvaluationRuns).mockResolvedValue({
    claimed: 0,
    completed: 0,
    released: 0,
    failed: 0,
    cancelled: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlatformJobsForTests();
  mockIdleTasks();
});

describe('PLATFORM_JOB_NAMES', () => {
  it('matches the order the tick route publishes as backgroundTasks', () => {
    // Order is contract — the response shape in
    // .context/orchestration/scheduling.md lists it verbatim.
    expect(PLATFORM_JOB_NAMES).toEqual([
      'webhookRetries',
      'hookRetries',
      'orphanSweep',
      'zombieReaper',
      'embeddingBackfill',
      'retention',
      'pendingExecutionRecovery',
      'evaluationRuns',
    ]);
  });

  it('exempts only the tasks whose backoff is sub-minute', () => {
    // A throttled retry drain would miss the 10s first retry entirely, so this
    // set is behavioural, not stylistic.
    const responsive = PLATFORM_JOBS.filter((job) => job.intervalMs === 0).map((job) => job.name);

    expect(responsive).toEqual(['webhookRetries', 'hookRetries', 'evaluationRuns']);
  });
});

describe('runDuePlatformJobs', () => {
  it('runs every task on a cold start and keys the summary by task name', async () => {
    const retentionResult = { ...RETENTION_IDLE, deleted: 7 };
    vi.mocked(enforceRetentionPolicies).mockResolvedValue(retentionResult);

    const { summary } = await runDuePlatformJobs(T0);

    for (const task of ALL_TASKS) expect(task).toHaveBeenCalledTimes(1);
    expect(summary.retention).toEqual(retentionResult);
    expect(Object.keys(summary)).toEqual([...PLATFORM_JOB_NAMES]);
  });

  it('calls each task with no arguments', async () => {
    // Several of these take an optional limit / maxAge first parameter. Passing
    // the tick clock into one by accident would silently change its window.
    await runDuePlatformJobs(T0);

    expect(processOrphanedExecutions).toHaveBeenCalledWith();
    expect(backfillMissingEmbeddings).toHaveBeenCalledWith();
    expect(enforceRetentionPolicies).toHaveBeenCalledWith();
  });

  it('on the very next tick runs only the retry drains and the eval worker', async () => {
    // This is the #442 fix: one minute later, an idle deployment must not
    // re-run the retention sweep or full-scan the message table.
    await runDuePlatformJobs(T0);
    vi.clearAllMocks();

    const { summary } = await runDuePlatformJobs(T0 + MINUTE);

    expect(processPendingRetries).toHaveBeenCalledTimes(1);
    expect(processPendingHookRetries).toHaveBeenCalledTimes(1);
    expect(processPendingEvaluationRuns).toHaveBeenCalledTimes(1);

    expect(processOrphanedExecutions).not.toHaveBeenCalled();
    expect(reapZombieExecutions).not.toHaveBeenCalled();
    expect(backfillMissingEmbeddings).not.toHaveBeenCalled();
    expect(enforceRetentionPolicies).not.toHaveBeenCalled();
    expect(processPendingExecutions).not.toHaveBeenCalled();

    // Reported, not omitted — an operator can see the cadence working.
    expect(summary.retention).toBe(THROTTLED);
    expect(summary.embeddingBackfill).toBe(THROTTLED);
  });

  it('releases each task at its own interval', async () => {
    await runDuePlatformJobs(T0);
    vi.clearAllMocks();

    // 2 min: the lease-aware sweeps only.
    await runDuePlatformJobs(T0 + 2 * MINUTE);
    expect(processOrphanedExecutions).toHaveBeenCalledTimes(1);
    expect(processPendingExecutions).toHaveBeenCalledTimes(1);
    expect(reapZombieExecutions).not.toHaveBeenCalled();
    expect(enforceRetentionPolicies).not.toHaveBeenCalled();

    // 5 min: the zombie reaper joins.
    await runDuePlatformJobs(T0 + 5 * MINUTE);
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(backfillMissingEmbeddings).not.toHaveBeenCalled();

    // 15 min: the embedding backfill joins.
    await runDuePlatformJobs(T0 + 15 * MINUTE);
    expect(backfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    expect(enforceRetentionPolicies).not.toHaveBeenCalled();

    // 1 hour: retention finally runs — 24×/day instead of 1,440×.
    await runDuePlatformJobs(T0 + 60 * MINUTE);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
  });

  it('contains a rejecting task and still runs the rest', async () => {
    vi.mocked(reapZombieExecutions).mockRejectedValue(new Error('DB down'));

    const { summary } = await runDuePlatformJobs(T0);

    expect(summary.zombieReaper).toEqual({ error: 'Error: DB down' });
    expect(summary.retention).toEqual(RETENTION_IDLE);
    expect(logger.error).toHaveBeenCalledWith(
      'maintenance task failed',
      expect.objectContaining({ task: 'zombieReaper', error: 'DB down' })
    );
  });

  it('never rejects, so the tick log line always gets written', async () => {
    for (const task of ALL_TASKS) vi.mocked(task).mockRejectedValue(new Error('everything down'));

    const { summary } = await runDuePlatformJobs(T0);

    expect(summary.retention).toEqual({ error: 'Error: everything down' });
  });

  it('does not start a second copy of a task that is still running', async () => {
    // The tick's watchdog can release the overlap guard while the chain is still
    // pending, so without the latch a hung sweep would be restarted every tick
    // and pile up.
    let release!: () => void;
    vi.mocked(reapZombieExecutions).mockReturnValue(
      new Promise<never>((resolve) => {
        release = resolve as () => void;
      })
    );

    const first = runDuePlatformJobs(T0);
    // An hour later it is very much due — but it is also still running.
    const { summary } = await runDuePlatformJobs(T0 + 60 * MINUTE);

    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(summary.zombieReaper).toBe(THROTTLED);

    release();
    await first;
  });

  it('re-runs a task that resolved on the previous tick once it is due again', async () => {
    // The mirror of the latch test: settling must clear the latch, or a task
    // would run exactly once per process lifetime.
    await runDuePlatformJobs(T0);
    await runDuePlatformJobs(T0 + 5 * MINUTE);

    expect(reapZombieExecutions).toHaveBeenCalledTimes(2);
  });
});

describe('runDuePlatformJobs — foundWork', () => {
  // This flag is the idle gate's licence to skip ticks entirely. A false
  // negative here is the one failure that loses work rather than costing
  // queries, so each predicate is pinned individually.

  it('is false when every task reports nothing', async () => {
    const { foundWork } = await runDuePlatformJobs(T0);

    expect(foundWork).toBe(false);
  });

  it.each([
    ['webhookRetries', () => vi.mocked(processPendingRetries).mockResolvedValue(1)],
    ['hookRetries', () => vi.mocked(processPendingHookRetries).mockResolvedValue(1)],
    [
      'orphanSweep — recovered',
      () =>
        vi
          .mocked(processOrphanedExecutions)
          .mockResolvedValue({ recovered: 1, exhausted: 0, errors: [] }),
    ],
    [
      'orphanSweep — errors',
      () =>
        vi.mocked(processOrphanedExecutions).mockResolvedValue({
          recovered: 0,
          exhausted: 0,
          errors: [{ executionId: 'exec_1', error: 'boom' }],
        }),
    ],
    [
      'zombieReaper',
      () =>
        vi
          .mocked(reapZombieExecutions)
          .mockResolvedValue({ reaped: 0, stalePending: 1, abandonedApprovals: 0 }),
    ],
    [
      'embeddingBackfill',
      () => vi.mocked(backfillMissingEmbeddings).mockResolvedValue({ processed: 25, failed: 0 }),
    ],
    [
      'retention',
      () =>
        vi
          .mocked(enforceRetentionPolicies)
          .mockResolvedValue({ ...RETENTION_IDLE, mcpAuditLogsDeleted: 3 }),
    ],
    [
      'pendingExecutionRecovery',
      () =>
        vi
          .mocked(processPendingExecutions)
          .mockResolvedValue({ recovered: 1, failed: 0, errors: [] }),
    ],
    [
      'evaluationRuns — a claimed run needs the next time-slice',
      () =>
        vi.mocked(processPendingEvaluationRuns).mockResolvedValue({
          claimed: 1,
          completed: 0,
          released: 1,
          failed: 0,
          cancelled: 0,
        }),
    ],
  ])('is true when %s found something', async (_label, arrange) => {
    arrange();

    const { foundWork } = await runDuePlatformJobs(T0);

    expect(foundWork).toBe(true);
  });

  it('is true when a task rejects, because the outcome is unknown', async () => {
    vi.mocked(enforceRetentionPolicies).mockRejectedValue(new Error('DB down'));

    const { foundWork } = await runDuePlatformJobs(T0);

    expect(foundWork).toBe(true);
  });

  it('is false when the only tasks that could have found work were throttled', async () => {
    // A throttled task says nothing either way — it must not be reported as
    // work, or the gate could never arm on a busy-then-idle deployment.
    vi.mocked(enforceRetentionPolicies).mockResolvedValue({ ...RETENTION_IDLE, deleted: 5 });
    await runDuePlatformJobs(T0);

    const { foundWork, summary } = await runDuePlatformJobs(T0 + MINUTE);

    expect(summary.retention).toBe(THROTTLED);
    expect(foundWork).toBe(false);
  });
});
