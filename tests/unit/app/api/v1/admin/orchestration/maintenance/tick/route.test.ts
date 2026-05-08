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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
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

vi.mock('@/lib/orchestration/retention', () => ({
  enforceRetentionPolicies: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';
import {
  processDueSchedules,
  processPendingExecutions,
  processOrphanedExecutions,
} from '@/lib/orchestration/scheduling';
import { processPendingRetries } from '@/lib/orchestration/webhooks/dispatcher';
import { processPendingHookRetries } from '@/lib/orchestration/hooks/registry';
import { reapZombieExecutions } from '@/lib/orchestration/engine/execution-reaper';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { enforceRetentionPolicies } from '@/lib/orchestration/retention';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import {
  POST,
  __test_setTickRunning,
} from '@/app/api/v1/admin/orchestration/maintenance/tick/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/maintenance/tick', {
    method: 'POST',
  });
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
  auditLogsDeleted: 0,
};
const DEFAULT_PENDING_RECOVERY_RESULT = { recovered: 0, failed: 0, errors: [] };
const DEFAULT_ORPHAN_RESULT = { recovered: 0, exhausted: 0, errors: [] };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/maintenance/tick', () => {
  afterEach(() => {
    // Background chain releases tickRunning in .finally — force-clear in case
    // a test holds a deferred task open or the microtask hasn't drained yet.
    __test_setTickRunning(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(createRateLimitResponse).mockReturnValue(
      Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
    );

    vi.mocked(processDueSchedules).mockResolvedValue(DEFAULT_SCHEDULE_RESULT);
    vi.mocked(processPendingRetries).mockResolvedValue(DEFAULT_RETRY_RESULT);
    vi.mocked(processPendingHookRetries).mockResolvedValue(DEFAULT_HOOK_RETRY_RESULT);
    vi.mocked(reapZombieExecutions).mockResolvedValue(DEFAULT_REAPER_RESULT);
    vi.mocked(backfillMissingEmbeddings).mockResolvedValue(DEFAULT_EMBEDDER_RESULT as never);
    vi.mocked(enforceRetentionPolicies).mockResolvedValue(DEFAULT_RETENTION_RESULT);
    vi.mocked(processPendingExecutions).mockResolvedValue(DEFAULT_PENDING_RECOVERY_RESULT);
    vi.mocked(processOrphanedExecutions).mockResolvedValue(DEFAULT_ORPHAN_RESULT);
  });

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

  it('returns 429 when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
  });

  it('does not run tasks when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    await POST(makeRequest());

    expect(processDueSchedules).not.toHaveBeenCalled();
  });

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
        totalDurationMs: expect.any(Number),
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
    // Background tasks still kick off even when schedules fail (7 tasks since orphanSweep added).
    expect(body.data.backgroundTasks).toHaveLength(7);
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

    it('a late-settling old chain does not release a newer tick guard (token ownership)', async () => {
      // Tick 1 hangs.
      const deferred1 = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(deferred1.promise);

      await POST(makeRequest());

      // Watchdog fires for tick 1, releasing the guard.
      await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_MS);

      // Tick 2 starts; hangs again. New token claims the guard.
      const deferred2 = createDeferred<typeof DEFAULT_REAPER_RESULT>();
      vi.mocked(reapZombieExecutions).mockReturnValue(deferred2.promise);

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
      deferred2.resolve(DEFAULT_REAPER_RESULT);
    });
  });
});
