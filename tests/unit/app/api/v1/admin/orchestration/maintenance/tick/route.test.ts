/**
 * Tests: Unified Maintenance Tick Endpoint
 *
 * POST /api/v1/admin/orchestration/maintenance/tick
 *
 * The tick awaits processDueSchedules synchronously, then runs the other
 * six maintenance tasks as a fire-and-forget background chain so the HTTP
 * response is bounded by schedule-claim work (DB ops only) rather than by
 * retention sweeps or embedding backfills.
 *
 * Test Coverage:
 * - 401 when unauthenticated
 * - 429 when rate limited
 * - 202 with schedules result + backgroundTasks list on success
 * - schedules.error in payload when processDueSchedules rejects
 * - All seven maintenance tasks are still invoked (six in the background)
 * - HTTP response returns before slow background tasks complete
 * - Overlap guard releases only after the background chain settles
 *
 * @see app/api/v1/admin/orchestration/maintenance/tick/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  processDueSchedules: vi.fn(),
  processPendingExecutions: vi.fn(),
  processOrphanedExecutions: vi.fn(),
  // The idle gate's horizon probe (#442).
  getNextScheduleRunAt: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  processPendingRetries: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  processPendingHookRetries: vi.fn(),
}));

vi.mock('@/lib/orchestration/engine/execution-reaper', () => ({
  reapZombieExecutions: vi.fn(),
}));

vi.mock('@/lib/orchestration/chat/message-embedder', () => ({
  backfillMissingEmbeddings: vi.fn(),
}));

// §108: every platform job now runs inside a tenant scope; the per-org runner
// reads the active orgs. One install org is what a `single` install has.
vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findMany: vi.fn(async () => [{ id: 'install' }]) } },
}));

vi.mock('@/lib/orchestration/retention', () => ({
  enforceRetentionPolicies: vi.fn(),
  enforceSystemRetentionPolicies: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/run-worker', () => ({
  processPendingEvaluationRuns: vi.fn(),
}));

// The fork seam (#469). Left unmocked, the real empty registry always resolves
// `undefined`, so neither the "a fork registered jobs" nor the rejection arm of
// the summary ever ran. Mocked with the same default so existing tests see no
// change.
vi.mock('@/lib/orchestration/maintenance/app-jobs', () => ({
  runDueAppJobs: vi.fn(),
  // Vanilla Sunrise registers none, so nothing bounds the idle gate's horizon.
  getAppJobsMinIntervalMs: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { logger } from '@/lib/logging';
import {
  processDueSchedules,
  processPendingExecutions,
  processOrphanedExecutions,
  getNextScheduleRunAt,
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
import { runDueAppJobs } from '@/lib/orchestration/maintenance/app-jobs';
import { __resetPlatformJobsForTests } from '@/lib/orchestration/maintenance/platform-jobs';
import { __resetIdleGateForTests } from '@/lib/orchestration/maintenance/idle-gate';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import {
  POST,
  __test_setTickRunning,
} from '@/app/api/v1/admin/orchestration/maintenance/tick/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(query = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/maintenance/tick${query}`,
    { method: 'POST' }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/** Returns a {promise, resolve} pair so a test can hold a background task pending. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DEFAULT_SCHEDULE_RESULT = {
  processed: 2,
  succeeded: 2,
  failed: 0,
  errors: [],
};
const DEFAULT_RETRY_RESULT = 3;
const DEFAULT_HOOK_RETRY_RESULT = 2;
const DEFAULT_REAPER_RESULT = { reaped: 1, stalePending: 0, abandonedApprovals: 0 };
const DEFAULT_EMBEDDER_RESULT = { backfilled: 5, failed: 0 };
const DEFAULT_RETENTION_RESULT = {
  deleted: 10,
  agentsProcessed: 2,
  webhookDeliveriesDeleted: 0,
  hookDeliveriesDeleted: 0,
  costLogsDeleted: 0,
  executionsDeleted: 0,
  evaluationSessionsDeleted: 0,
  evaluationRunsDeleted: 0,
};
const DEFAULT_PENDING_RECOVERY_RESULT = { recovered: 0, failed: 0, errors: [] };
const DEFAULT_ORPHAN_RESULT = { recovered: 0, exhausted: 0, errors: [] };
const DEFAULT_EVAL_RUN_RESULT = { claimed: 0, completed: 0, released: 0, failed: 0, cancelled: 0 };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/maintenance/tick', () => {
  afterEach(() => {
    // Background chain releases tickRunning in .finally — force-clear in case
    // a test holds a deferred task open or the microtask hasn't drained yet.
    __test_setTickRunning(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Per-task intervals and the idle gate (#442) are module-level state that
    // outlives a single test. Without this, the second test in the file sees
    // `retention` and friends still inside their interval and they never run.
    __resetPlatformJobsForTests();
    __resetIdleGateForTests();

    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    vi.mocked(processDueSchedules).mockResolvedValue(DEFAULT_SCHEDULE_RESULT);
    vi.mocked(processPendingRetries).mockResolvedValue(DEFAULT_RETRY_RESULT);
    vi.mocked(processPendingHookRetries).mockResolvedValue(DEFAULT_HOOK_RETRY_RESULT);
    vi.mocked(reapZombieExecutions).mockResolvedValue(DEFAULT_REAPER_RESULT);
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue(DEFAULT_EMBEDDER_RESULT as never);
    vi.mocked(enforceRetentionPolicies).mockResolvedValue(DEFAULT_RETENTION_RESULT);
    vi.mocked(enforceSystemRetentionPolicies).mockResolvedValue({
      auditLogsDeleted: 0,
      mcpAuditLogsDeleted: 0,
    });
    vi.mocked(processPendingExecutions).mockResolvedValue(DEFAULT_PENDING_RECOVERY_RESULT);
    vi.mocked(processOrphanedExecutions).mockResolvedValue(DEFAULT_ORPHAN_RESULT);
    vi.mocked(processPendingEvaluationRuns).mockResolvedValue(DEFAULT_EVAL_RUN_RESULT);
    // Vanilla default: no fork jobs registered.
    vi.mocked(runDueAppJobs).mockResolvedValue(undefined);
    // No schedule on the horizon unless a test says otherwise.
    vi.mocked(getNextScheduleRunAt).mockResolvedValue(null);
  });

  /**
   * Make every task report "nothing found", which is what lets the idle gate arm.
   * The suite's defaults deliberately report work, so most tests never arm it.
   */
  function mockIdleSweep(): void {
    vi.mocked(processDueSchedules).mockResolvedValue({
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    });
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
    vi.mocked(enforceRetentionPolicies).mockResolvedValue({
      ...DEFAULT_RETENTION_RESULT,
      deleted: 0,
    });
    vi.mocked(processPendingExecutions).mockResolvedValue({
      recovered: 0,
      failed: 0,
      errors: [],
    });
    vi.mocked(processPendingEvaluationRuns).mockResolvedValue(DEFAULT_EVAL_RUN_RESULT);
  }

  /** Run one tick and let its background chain settle. */
  async function tick(query = ''): Promise<Response> {
    const response = await POST(makeRequest(query));
    await new Promise((resolve) => setImmediate(resolve));
    return response;
  }

  // ── Authentication ───────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
  });

  it('does not call any maintenance tasks when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    await POST(makeRequest());

    expect(processDueSchedules).not.toHaveBeenCalled();
    expect(processPendingRetries).not.toHaveBeenCalled();
    expect(reapZombieExecutions).not.toHaveBeenCalled();
    expect(backfillMissingEmbeddings).not.toHaveBeenCalled();
    expect(enforceRetentionPolicies).not.toHaveBeenCalled();
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  // ── Happy path ───────────────────────────────────────────────────────────

  it('returns 202 with schedules result and backgroundTasks list', async () => {
    const response = await POST(makeRequest());
    const body = await parseJson<{
      success: boolean;
      data: { schedules: unknown; backgroundTasks: string[]; durationMs: number };
    }>(response);

    expect(response.status).toBe(202);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.schedules).toEqual(DEFAULT_SCHEDULE_RESULT);
    // Full ordered array — position of 'orphanSweep' between 'hookRetries' and 'zombieReaper' is contract
    expect(body.data.backgroundTasks).toEqual([
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
    expect(typeof body.data.durationMs).toBe('number');
    expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not include background task results in the synchronous response', async () => {
    const response = await POST(makeRequest());
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    expect(body.data).not.toHaveProperty('webhookRetries');
    expect(body.data).not.toHaveProperty('hookRetries');
    expect(body.data).not.toHaveProperty('orphanSweep');
    expect(body.data).not.toHaveProperty('zombieReaper');
    expect(body.data).not.toHaveProperty('embeddingBackfill');
    expect(body.data).not.toHaveProperty('retention');
    expect(body.data).not.toHaveProperty('pendingExecutionRecovery');
    expect(body.data).not.toHaveProperty('evaluationRuns');
    expect(body.data).not.toHaveProperty('auditLogRetention');
  });

  it('still invokes all seven maintenance tasks (six in background)', async () => {
    await POST(makeRequest());
    // Drain microtasks so the background chain has a chance to fire.
    await new Promise((resolve) => setImmediate(resolve));

    expect(processDueSchedules).toHaveBeenCalledTimes(1);
    expect(processPendingRetries).toHaveBeenCalledTimes(1);
    expect(processPendingHookRetries).toHaveBeenCalledTimes(1);
    // orphanSweep takes no args — a parameter regression would be caught here
    expect(processOrphanedExecutions).toHaveBeenCalledTimes(1);
    expect(processOrphanedExecutions).toHaveBeenCalledWith();
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(backfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
    expect(processPendingExecutions).toHaveBeenCalledTimes(1);
  });

  it('logs background task summary when the chain settles', async () => {
    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        webhookRetries: DEFAULT_RETRY_RESULT,
        hookRetries: DEFAULT_HOOK_RETRY_RESULT,
        orphanSweep: DEFAULT_ORPHAN_RESULT,
        zombieReaper: DEFAULT_REAPER_RESULT,
        embeddingBackfill: DEFAULT_EMBEDDER_RESULT,
        retention: DEFAULT_RETENTION_RESULT,
        pendingExecutionRecovery: DEFAULT_PENDING_RECOVERY_RESULT,
        evaluationRuns: DEFAULT_EVAL_RUN_RESULT,
        totalDurationMs: expect.any(Number),
      })
    );
  });

  it('a back-to-back tick re-runs only the responsive tasks (#442)', async () => {
    // Two ticks a few ms apart stand in for two cron fires a minute apart: the
    // retry drains must still run, and the sweeps whose own thresholds are
    // minutes must not touch the database at all.
    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));
    vi.mocked(logger.info).mockClear();

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(processPendingRetries).toHaveBeenCalledTimes(2);
    expect(processPendingHookRetries).toHaveBeenCalledTimes(2);
    expect(processPendingEvaluationRuns).toHaveBeenCalledTimes(2);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
    expect(backfillMissingEmbeddings).toHaveBeenCalledTimes(1);
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(processOrphanedExecutions).toHaveBeenCalledTimes(1);
    expect(processPendingExecutions).toHaveBeenCalledTimes(1);

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        webhookRetries: DEFAULT_RETRY_RESULT,
        retention: 'skipped',
        embeddingBackfill: 'skipped',
        zombieReaper: 'skipped',
      })
    );
  });

  // ── Non-blocking behaviour ───────────────────────────────────────────────

  it('returns the HTTP response before slow background tasks complete', async () => {
    // Hold the slowest task pending — the response must still come back.
    const deferred = createDeferred<typeof DEFAULT_RETENTION_RESULT>();
    vi.mocked(enforceRetentionPolicies).mockReturnValue(deferred.promise);

    const response = await POST(makeRequest());

    expect(response.status).toBe(202);
    // Background task is still pending — guard is held.
    // (We resolve it here so afterEach cleanup completes cleanly.)
    deferred.resolve(DEFAULT_RETENTION_RESULT);
  });

  // ── Schedules failure ────────────────────────────────────────────────────

  it('returns schedules.error in payload when processDueSchedules rejects', async () => {
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('schedules DB down'));

    const response = await POST(makeRequest());
    const body = await parseJson<{
      data: { schedules: { error: string }; backgroundTasks: string[] };
    }>(response);

    expect(response.status).toBe(202);
    expect(body.data.schedules).toEqual({ error: 'schedules DB down' });
    // Background tasks still kick off even when schedules fail
    // (9 tasks: evaluationRuns added in Phase 1, auditLogRetention split out in §108).
    expect(body.data.backgroundTasks).toHaveLength(9);
  });

  it('returns a readable schedules.error when processDueSchedules rejects a non-Error', async () => {
    // A thrown string has no `.message`; without the String() fallback the
    // payload would report `{ error: undefined }` and the operator would see a
    // failed sweep with no reason.
    vi.mocked(processDueSchedules).mockRejectedValue('PG connection reset');

    const response = await POST(makeRequest());
    const body = await parseJson<{ data: { schedules: { error: string } } }>(response);

    expect(body.data.schedules).toEqual({ error: 'PG connection reset' });
  });

  it('omits appJobs from the summary when no fork job is registered', async () => {
    // Vanilla Sunrise: the seam must not add a key to the tick's log line.
    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    const [, payload] = vi
      .mocked(logger.info)
      .mock.calls.find(([msg]) => msg === 'Maintenance tick background tasks completed')!;
    expect(payload).not.toHaveProperty('appJobs');
  });

  it('folds a fork job summary into the tick log line', async () => {
    vi.mocked(runDueAppJobs).mockResolvedValue({ 'app:sweep': { pruned: 4 }, skipped: 1 });

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({ appJobs: { 'app:sweep': { pruned: 4 }, skipped: 1 } })
    );
  });

  it('surfaces an app-jobs rejection as { error } without losing the platform summary', async () => {
    // `runDueAppJobs` contains its own failures, so this arm is defensive — but
    // it is the arm that decides whether a seam bug takes the whole log line
    // down with it, so it is worth pinning.
    vi.mocked(runDueAppJobs).mockRejectedValue(new Error('registry exploded'));

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        appJobs: { error: expect.stringContaining('registry exploded') },
        // The platform tasks are still reported.
        webhookRetries: DEFAULT_RETRY_RESULT,
      })
    );
  });

  it('still kicks off background tasks when schedules reject', async () => {
    vi.mocked(processDueSchedules).mockRejectedValue(new Error('schedules DB down'));

    await POST(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(processPendingRetries).toHaveBeenCalledTimes(1);
    expect(reapZombieExecutions).toHaveBeenCalledTimes(1);
    expect(enforceRetentionPolicies).toHaveBeenCalledTimes(1);
  });

  it('orphanSweep rejection surfaces as { error } in background summary', async () => {
    // Arrange: processOrphanedExecutions rejects; Promise.allSettled catches it and
    // the route maps it to { error: String(reason) } in the summary log.
    vi.mocked(processOrphanedExecutions).mockRejectedValue(new Error('DB down'));

    // Act
    await POST(makeRequest());
    // Drain microtasks so the Promise.allSettled chain settles and logger.info fires.
    await new Promise((resolve) => setImmediate(resolve));

    // Assert: the summary log contains orphanSweep mapped to an error object,
    // not the raw rejection reason — this is the route's contract for rejected tasks.
    expect(logger.info).toHaveBeenCalledWith(
      'Maintenance tick background tasks completed',
      expect.objectContaining({
        orphanSweep: { error: expect.stringContaining('DB down') },
      })
    );
  });

  it('does not call processOrphanedExecutions when unauthenticated', async () => {
    // Arrange: no session — withAdminAuth should short-circuit before any tasks run.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    await POST(makeRequest());

    // Assert: guard fires before the background chain is ever constructed
    expect(processOrphanedExecutions).not.toHaveBeenCalled();
  });

  // ── Idle gate (#442) ─────────────────────────────────────────────────────

  describe('idle gate', () => {
    const ALL_TASKS = [
      processDueSchedules,
      processPendingRetries,
      processPendingHookRetries,
      processOrphanedExecutions,
      reapZombieExecutions,
      backfillMissingEmbeddings,
      enforceRetentionPolicies,
      processPendingExecutions,
      processPendingEvaluationRuns,
    ];

    it('after a sweep that found nothing, the next tick does zero database work', async () => {
      // The whole point of #442: not "fewer queries" but *none*, so a
      // scale-to-zero Postgres can actually autosuspend.
      mockIdleSweep();
      await tick();
      vi.clearAllMocks();

      const response = await tick();
      const body = await parseJson<{ data: { skipped: boolean; reason: string } }>(response);

      expect(response.status).toBe(200);
      expect(body.data.reason).toBe('idle');
      for (const task of ALL_TASKS) expect(task).not.toHaveBeenCalled();
      expect(getNextScheduleRunAt).not.toHaveBeenCalled();
    });

    it('reports when it will next sweep', async () => {
      mockIdleSweep();
      await tick();

      const response = await tick();
      const body = await parseJson<{ data: { resumesAt: string } }>(response);

      expect(Date.parse(body.data.resumesAt)).toBeGreaterThan(Date.now());
    });

    it('does not arm when a task found work', async () => {
      // Default mocks report work (3 retries, a reaped zombie, 2 schedules), so
      // this is the active-deployment path: every tick keeps sweeping.
      await tick();
      vi.clearAllMocks();

      const response = await tick();

      expect(response.status).toBe(202);
      expect(processDueSchedules).toHaveBeenCalledTimes(1);
    });

    it('does not arm when the schedules sweep errored', async () => {
      // A sweep that failed knows nothing about the state of the queue, so it
      // must not license a skip.
      mockIdleSweep();
      vi.mocked(processDueSchedules).mockRejectedValue(new Error('DB down'));
      await tick();
      vi.clearAllMocks();
      vi.mocked(processDueSchedules).mockResolvedValue(DEFAULT_SCHEDULE_RESULT);

      const response = await tick();

      expect(response.status).toBe(202);
      expect(processDueSchedules).toHaveBeenCalledTimes(1);
    });

    it('does not arm when the horizon probe fails', async () => {
      mockIdleSweep();
      vi.mocked(getNextScheduleRunAt).mockRejectedValue(new Error('probe failed'));

      await tick();
      const response = await tick();

      expect(response.status).toBe(202);
      expect(logger.warn).toHaveBeenCalledWith(
        'Maintenance tick: schedule horizon unavailable; leaving the idle gate disarmed',
        expect.objectContaining({ error: 'probe failed' })
      );
    });

    it('never skips past a due schedule', async () => {
      // A schedule due in 40s must still fire on time — the gate takes the
      // horizon from the probe instead of its own cap.
      mockIdleSweep();
      const dueAt = new Date(Date.now() + 40_000);
      vi.mocked(getNextScheduleRunAt).mockResolvedValue(dueAt);

      await tick();
      const response = await tick();
      const body = await parseJson<{ data: { resumesAt: string } }>(response);

      expect(body.data.resumesAt).toBe(dueAt.toISOString());
    });

    it('?force=1 sweeps even while armed', async () => {
      mockIdleSweep();
      await tick();
      vi.clearAllMocks();

      const response = await tick('?force=1');

      expect(response.status).toBe(202);
      expect(processDueSchedules).toHaveBeenCalledTimes(1);
    });

    it('a normal tick right after a forced one is still skipped', async () => {
      // `force` is a one-off override, not a reset: the forced sweep found
      // nothing, so the gate re-arms.
      mockIdleSweep();
      await tick();
      await tick('?force=1');
      vi.clearAllMocks();

      const response = await tick();
      const body = await parseJson<{ data: { reason: string } }>(response);

      expect(body.data.reason).toBe('idle');
      expect(processDueSchedules).not.toHaveBeenCalled();
    });

    it('logs the armed horizon in the completion line', async () => {
      mockIdleSweep();

      await tick();

      expect(logger.info).toHaveBeenCalledWith(
        'Maintenance tick background tasks completed',
        expect.objectContaining({ idleUntilMs: expect.any(Number) })
      );
    });

    it('omits the horizon from the completion line when it did not arm', async () => {
      await tick();

      const [, payload] = vi
        .mocked(logger.info)
        .mock.calls.find(([msg]) => msg === 'Maintenance tick background tasks completed')!;
      expect(payload).not.toHaveProperty('idleUntilMs');
    });
  });

  // ── Overlap guard ────────────────────────────────────────────────────────

  it('returns skipped when a previous tick is still running', async () => {
    __test_setTickRunning(true);

    const response = await POST(makeRequest());
    const body = await parseJson<{
      success: boolean;
      data: { skipped: boolean; reason: string };
    }>(response);

    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.skipped).toBe(true);
    expect(body.data.reason).toBe('previous tick still running');

    expect(processDueSchedules).not.toHaveBeenCalled();
  });

  it('holds the overlap guard while background tasks are pending', async () => {
    const deferred = createDeferred<typeof DEFAULT_REAPER_RESULT>();
    vi.mocked(reapZombieExecutions).mockReturnValue(deferred.promise);

    const first = await POST(makeRequest());
    expect(first.status).toBe(202);

    // Second tick while background is pending — must be skipped.
    const second = await POST(makeRequest());
    const body = await parseJson<{ data: { skipped: boolean } }>(second);
    expect(body.data.skipped).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.skipped).toBe(true);

    // Resolve and let the background chain settle.
    deferred.resolve(DEFAULT_REAPER_RESULT);
    await new Promise((resolve) => setImmediate(resolve));

    // Third tick after the chain settled — should run.
    const third = await POST(makeRequest());
    expect(third.status).toBe(202);
    const thirdBody = await parseJson<{ data: { skipped?: boolean } }>(third);
    expect(thirdBody.data.skipped).toBeUndefined();
  });

  // ── Watchdog ─────────────────────────────────────────────────────────────

  describe('background-chain watchdog', () => {
    const BACKGROUND_TASK_MAX_MS = 5 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('force-releases the guard if the background chain hangs past the max duration', async () => {
      // Hang the background chain by holding a deferred forever.
      const deferred = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(deferred.promise);

      const first = await POST(makeRequest());
      expect(first.status).toBe(202);

      // While the chain is pending, a second tick is correctly skipped.
      const skipped = await POST(makeRequest());
      const skippedBody = await parseJson<{ data: { skipped?: boolean } }>(skipped);
      expect(skippedBody.data.skipped).toBe(true);

      // Advance past the watchdog timeout.
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      // The watchdog should have logged a warning and released the guard.
      expect(logger.warn).toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.objectContaining({ maxDurationMs: BACKGROUND_TASK_MAX_MS })
      );

      // A subsequent tick now runs instead of being skipped.
      const recovered = await POST(makeRequest());
      const recoveredBody = await parseJson<{ data: { skipped?: boolean } }>(recovered);
      expect(recovered.status).toBe(202);
      expect(recoveredBody.data.skipped).toBeUndefined();

      // Resolve the original deferred so afterEach can clean up.
      deferred.resolve(DEFAULT_REAPER_RESULT);
    });

    it('does not warn when the background chain settles before the watchdog fires', async () => {
      const first = await POST(makeRequest());
      expect(first.status).toBe(202);

      // Drain microtasks so the background chain has a chance to settle.
      await vi.advanceTimersByTimeAsync(0);

      // Now advance past the watchdog timeout — it should already have been cleared.
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      expect(logger.warn).not.toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.any(Object)
      );
    });

    it('releases tickRunning after the background chain settles immediately (watchdog !tickRunning arm)', async () => {
      // Arrange: all tasks resolve in microtasks (default mock setup).
      // The background chain settles and calls .finally before the watchdog fires.
      // The watchdog's `!tickRunning` guard must short-circuit and NOT emit a warning.
      const first = await POST(makeRequest());
      expect(first.status).toBe(202);

      // Drain microtasks — background chain settles and releases tickRunning.
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the watchdog timeout. tickRunning is now false so the
      // watchdog body's early return (`!tickRunning`) fires — no warn logged.
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS + 1);

      // Assert: watchdog warn NOT emitted because the chain already settled.
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.any(Object)
      );

      // tickRunning released — a subsequent tick must not be skipped.
      const second = await POST(makeRequest());
      expect(second.status).toBe(202);
      const secondBody = await parseJson<{ data: { skipped?: boolean } }>(second);
      expect(secondBody.data.skipped).toBeUndefined();
    });

    it('a fired watchdog returns early when the guard was already released', async () => {
      // The `!tickRunning` arm. The existing "settles immediately" test asserts
      // no warning, but gets that from `.finally` clearing the timer — the
      // watchdog body never runs there. This arms the watchdog, drops the guard
      // without settling the chain, and lets it actually fire.
      const hung = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(hung.promise);

      await POST(makeRequest()); // token 1, watchdog 1 armed, chain pending
      __test_setTickRunning(false); // guard down, timer still armed

      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      // Token still matches, so the guard check is what short-circuits: no
      // warning about a chain that is no longer holding anything.
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.objectContaining({ maxDurationMs: BACKGROUND_TASK_MAX_MS })
      );

      hung.resolve(DEFAULT_REAPER_RESULT);
    });

    it('an old watchdog firing after a newer tick started leaves the new guard alone', async () => {
      // The `currentTickToken !== myTickToken` arm. Reaching it needs tick 1's
      // watchdog pending while a later tick owns the token — which the normal
      // paths never produce, because tick 1's `.finally` clears its own watchdog
      // and its watchdog firing is what releases the guard. Forcing the guard
      // down is what `__test_setTickRunning` is exported for.
      const hung = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(hung.promise);

      await POST(makeRequest()); // token 1, watchdog 1 armed, chain pending
      __test_setTickRunning(false);

      // Tick 2 completes normally, so ITS watchdog is cleared and only the stale
      // one is left armed — otherwise both fire on the same advance and tick 2's
      // legitimate warning masks what tick 1's did.
      vi.mocked(reapZombieExecutions).mockResolvedValue(DEFAULT_REAPER_RESULT);
      const second = await POST(makeRequest()); // token 2
      expect(second.status).toBe(202);
      await vi.advanceTimersByTimeAsync(0); // tick 2 settles, clears watchdog 2

      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      expect(logger.warn).not.toHaveBeenCalledWith(
        'Maintenance tick: background chain exceeded max duration; releasing guard',
        expect.objectContaining({ maxDurationMs: BACKGROUND_TASK_MAX_MS })
      );

      // And a fresh tick is still accepted — the stale watchdog touched nothing.
      const third = await POST(makeRequest());
      const thirdBody = await parseJson<{ data: { skipped?: boolean } }>(third);
      expect(thirdBody.data.skipped).toBeUndefined();

      hung.resolve(DEFAULT_REAPER_RESULT);
    });

    it('a late-settling old chain does not release a newer tick guard (token ownership)', async () => {
      // Tick 1 hangs.
      const deferred1 = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(deferred1.promise);

      await POST(makeRequest());

      // Watchdog fires for tick 1, releasing the guard.
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      // Tick 2 starts; hangs again. New token claims the guard. It has to hang
      // on a *different* task: the per-job in-flight latch (#442) means tick 1's
      // still-pending reaper is skipped rather than started a second time, so
      // re-deferring the reaper here would let tick 2's chain settle at once.
      const deferred2 = createDeferred<number>();
      vi.mocked(processPendingRetries).mockReturnValue(deferred2.promise);

      const second = await POST(makeRequest());
      expect(second.status).toBe(202);

      // Tick 1's deferred finally resolves — its .finally MUST NOT release the
      // guard because tick 2 currently owns it.
      deferred1.resolve(DEFAULT_REAPER_RESULT);
      await vi.advanceTimersByTimeAsync(0);

      // Confirm the guard is still held by tick 2 — a fresh tick is skipped.
      const stillSkipped = await POST(makeRequest());
      const stillSkippedBody = await parseJson<{ data: { skipped?: boolean } }>(stillSkipped);
      expect(stillSkippedBody.data.skipped).toBe(true);

      // Cleanup.
      deferred2.resolve(DEFAULT_RETRY_RESULT);
    });
  });
});
