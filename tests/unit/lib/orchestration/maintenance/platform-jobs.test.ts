// @vitest-environment happy-dom

/**
 * Tests for `lib/orchestration/maintenance/platform-jobs.ts` (#442).
 *
 * The point of this table is that an idle tick stops doing database work it
 * cannot possibly benefit from. So the assertions that matter are: which tasks
 * are exempt from throttling (the retry drains — throttling them would miss a
 * 10s backoff), which are held back and for how long, and that a task failing
 * or hanging cannot take the rest of the sweep with it.
 *
 * Since §108 (t-711) every task also declares whose rows it acts on. The
 * tenancy primitives are real here (env and the `Org` read mocked) so the
 * assertions are about the context each task actually ran in: once inside the
 * install org at `single` with the summary unchanged, once per org at `multi`.
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
  processOrphanedExecutions: vi.fn(),
  processPendingExecutions: vi.fn(),
}));
vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({ processPendingRetries: vi.fn() }));
vi.mock('@/lib/orchestration/hooks/registry', () => ({ processPendingHookRetries: vi.fn() }));
vi.mock('@/lib/orchestration/engine/execution-reaper', () => ({ reapZombieExecutions: vi.fn() }));
vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  backfillMissingEmbeddings: vi.fn(),
}));
vi.mock('@/lib/orchestration/retention', () => ({
  enforceRetentionPolicies: vi.fn(),
  enforceSystemRetentionPolicies: vi.fn(),
}));
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
import {
  enforceRetentionPolicies,
  enforceSystemRetentionPolicies,
} from '@/lib/orchestration/retention';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import {
  PLATFORM_JOBS,
  PLATFORM_JOB_NAMES,
  THROTTLED,
  runDuePlatformJobs,
  __resetPlatformJobsForTests,
} from '@/lib/orchestration/maintenance/platform-jobs';

const MINUTE = 60 * 1000;
const T0 = 1_000_000;

/** Every task that runs per org, in table order. */
const PER_ORG_TASKS = [
  processPendingRetries,
  processPendingHookRetries,
  processOrphanedExecutions,
  reapZombieExecutions,
  backfillMissingEmbeddings,
  enforceRetentionPolicies,
  processPendingExecutions,
  processPendingEvaluationRuns,
];

const ALL_TASKS = [...PER_ORG_TASKS, enforceSystemRetentionPolicies];

const RETENTION_IDLE = {
  deleted: 0,
  agentsProcessed: 0,
  webhookDeliveriesDeleted: 0,
  hookDeliveriesDeleted: 0,
  costLogsDeleted: 0,
  executionsDeleted: 0,
  evaluationSessionsDeleted: 0,
  evaluationRunsDeleted: 0,
};

const SYSTEM_RETENTION_IDLE = { auditLogsDeleted: 0, mcpAuditLogsDeleted: 0 };

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function orgs(...ids: string[]): void {
  mockOrgFindMany.mockResolvedValue(ids.map((id) => ({ id })));
}

/** The tenant context a mocked task saw on each call, in call order. */
function contextsSeenBy(task: (typeof ALL_TASKS)[number]): Array<string | null | undefined> {
  const seen: Array<string | null | undefined> = [];
  vi.mocked(task).mockImplementation(async () => {
    const ctx = getTenantContext();
    seen.push(ctx === null ? undefined : ctx.orgId);
    return undefined as never;
  });
  return seen;
}

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
  vi.mocked(enforceSystemRetentionPolicies).mockResolvedValue(SYSTEM_RETENTION_IDLE);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlatformJobsForTests();
  mockIdleTasks();
  mockEnv.TENANCY_MODE = 'single';
  orgs(INSTALL_ORG_ID);
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
      'auditLogRetention',
    ]);
  });

  it('declares a scope on every task, and only the audit-table prune runs as system (§108)', () => {
    // Every task that touches a tenant-owned table is per-org: under the
    // system scope nothing is stamped, and the reaper, recovery, the scheduler
    // and the evaluation worker all CREATE rows. The one system task prunes
    // two tables that have no org column at all.
    const scopes = PLATFORM_JOBS.map((job) => [job.name, job.scope] as const);

    expect(scopes).toEqual([
      ['webhookRetries', 'per-org'],
      ['hookRetries', 'per-org'],
      ['orphanSweep', 'per-org'],
      ['zombieReaper', 'per-org'],
      ['embeddingBackfill', 'per-org'],
      ['retention', 'per-org'],
      ['pendingExecutionRecovery', 'per-org'],
      ['evaluationRuns', 'per-org'],
      ['auditLogRetention', { system: expect.stringContaining('audit') }],
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
          .mockResolvedValue({ ...RETENTION_IDLE, executionsDeleted: 3 }),
    ],
    [
      'auditLogRetention',
      () =>
        vi
          .mocked(enforceSystemRetentionPolicies)
          .mockResolvedValue({ auditLogsDeleted: 0, mcpAuditLogsDeleted: 3 }),
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

describe('runDuePlatformJobs — tenant scope (§108)', () => {
  it('at single runs every per-org task once, inside the install org, and the summary is the raw result', async () => {
    const seen = PER_ORG_TASKS.filter((task) => task !== enforceRetentionPolicies).map((task) =>
      contextsSeenBy(task)
    );
    vi.mocked(enforceRetentionPolicies).mockResolvedValue({ ...RETENTION_IDLE, deleted: 2 });

    const { summary } = await runDuePlatformJobs(T0);

    for (const contexts of seen) expect(contexts).toEqual([INSTALL_ORG_ID]);
    // No fold at single: the log line keeps the shape it has always had.
    expect(summary.retention).toEqual({ ...RETENTION_IDLE, deleted: 2 });
    expect(summary.retention).not.toHaveProperty('orgs');
  });

  it('runs the audit-table prune under the system scope, not inside any org', async () => {
    const seen = contextsSeenBy(enforceSystemRetentionPolicies);

    await runDuePlatformJobs(T0);

    // `null` orgId = the system scope entered; `undefined` would mean no scope.
    expect(seen).toEqual([null]);
    expect(logger.info).toHaveBeenCalledWith(
      'Entering system tenant scope',
      expect.objectContaining({ reason: expect.stringContaining('auditLogRetention') })
    );
  });

  it('at multi runs each per-org task once per active org, in that org, and folds the summary', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    const seen = contextsSeenBy(processPendingRetries);
    vi.mocked(processOrphanedExecutions).mockImplementation(async () => ({
      recovered: getTenantContext()?.orgId === ORG_A ? 1 : 4,
      exhausted: 0,
      errors: [],
    }));

    const { summary, foundWork } = await runDuePlatformJobs(T0);

    expect(seen).toEqual([ORG_A, ORG_B]);
    expect(summary.orphanSweep).toEqual({ orgs: 2, recovered: 5, exhausted: 0, errors: [] });
    // The system task still ran exactly once.
    expect(enforceSystemRetentionPolicies).toHaveBeenCalledTimes(1);
    expect(foundWork).toBe(true);
  });

  it('at multi contains one org’s failure and still runs the task for the other org', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    vi.mocked(reapZombieExecutions).mockImplementation(async () => {
      if (getTenantContext()?.orgId === ORG_A) throw new Error('A down');
      return { reaped: 1, stalePending: 0, abandonedApprovals: 0 };
    });

    const { summary, foundWork } = await runDuePlatformJobs(T0);

    expect(reapZombieExecutions).toHaveBeenCalledTimes(2);
    expect(summary.zombieReaper).toEqual({
      orgs: 2,
      reaped: 1,
      stalePending: 0,
      abandonedApprovals: 0,
      orgErrors: [{ orgId: ORG_A, error: 'A down' }],
    });
    expect(foundWork).toBe(true);
    // Other tasks were untouched by A's failure in the reaper.
    expect(summary.retention).toEqual({ orgs: 2, ...RETENTION_IDLE });
  });

  it('ignores the org the caller entered — a tick fired from an admin session sweeps every org', async () => {
    // `withAdminAuth` enters the admin's active org before the tick route runs.
    // Before §108 every task inherited it and ran for that one org only.
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    const seen = contextsSeenBy(processPendingHookRetries);

    await runAsOrg('org_of_the_admin', () => runDuePlatformJobs(T0));

    expect(seen).toEqual([ORG_A, ORG_B]);
  });
});
