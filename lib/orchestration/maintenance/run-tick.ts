/**
 * Shared maintenance-tick body.
 *
 * Used by both:
 *   - `POST /api/v1/admin/orchestration/maintenance/tick` (external cron / manual)
 *   - `instrumentation.ts` (dev-only setInterval)
 *
 * Encapsulates the overlap guard, watchdog, schedule sweep, background
 * task chain, and per-task logging. Callers receive the schedules
 * result and a `skipped` flag so the HTTP route can shape its response.
 *
 * The background tasks themselves live in `platform-jobs.ts`, each with a
 * minimum interval — a task held back by its interval reports `'skipped'` in
 * the completion log line rather than being omitted (#442).
 *
 * **Tenant scope (§108 t-711).** Nothing in this file assumes a tenant
 * context, and nothing in it inherits one: each platform and app job enters
 * its own scope through `job-scope.ts`, the schedules sweep runs once per org
 * the same way, and the one genuinely global read — the idle-gate horizon,
 * the earliest `nextRunAt` across every org — runs under the audited system
 * scope. So a tick fired from an admin's session (whose guard entered that
 * admin's org) sweeps every org, not the caller's; the test pins it.
 */

import { logger } from '@/lib/logging';
import { processDueSchedules, getNextScheduleRunAt } from '@/lib/orchestration/scheduling';
import { runDueAppJobs, getAppJobsMinIntervalMs } from '@/lib/orchestration/maintenance/app-jobs';
import { runScopedJob, type PerOrgSummary } from '@/lib/orchestration/maintenance/job-scope';
import { listActiveOrgIds, runAsSystem } from '@/lib/tenancy/context';
import {
  PLATFORM_JOB_NAMES,
  runDuePlatformJobs,
} from '@/lib/orchestration/maintenance/platform-jobs';
import {
  armIdleGate,
  idleGateResumesAt,
  noteMaintenanceWork,
  shouldSkipIdleTick,
} from '@/lib/orchestration/maintenance/idle-gate';

/** Module-level guard against overlapping tick executions. */
let tickRunning = false;

/**
 * Per-tick monotonic token. Each accepted tick claims a fresh token and
 * tags its background chain + watchdog with it. Only the owning token
 * can release `tickRunning` — prevents a late-settling old chain (whose
 * watchdog already force-released the guard) from accidentally
 * releasing a newer tick's guard.
 */
let currentTickToken = 0;

/** Exposed for testing only — simulate an in-progress tick. */
export function __test_setTickRunning(value: boolean): void {
  tickRunning = value;
}

/**
 * Background task names, in run order — published by the tick route as
 * `backgroundTasks`. Derived from `PLATFORM_JOBS` so the list and the tasks
 * that actually run cannot drift apart.
 */
export const BACKGROUND_TASK_NAMES = PLATFORM_JOB_NAMES;

/**
 * Watchdog timeout for the background chain. Five minutes is a generous
 * upper bound — any single maintenance task taking longer than this is
 * a real incident worth flagging via the warning log line.
 */
const BACKGROUND_TASK_MAX_MS = 5 * 60 * 1000;

/**
 * The awaited schedules sweep as the route reports it: one org's result (a
 * `single` install, unchanged), the fold across orgs at `multi` (counters
 * summed, `errors` concatenated, plus `orgs` and any `orgErrors`), or the
 * sweep's own failure.
 */
export type ScheduleResult =
  Awaited<ReturnType<typeof processDueSchedules>> | PerOrgSummary | { error: string };

export interface TickResult {
  /** Skipped — either a previous tick is still running, or the gate is armed. */
  skipped: boolean;
  /** Why it was skipped. Present only when `skipped`. */
  reason?: 'previous tick still running' | 'idle';
  /** When an idle skip will next sweep (epoch ms). Present only for `reason: 'idle'`. */
  resumesAtMs?: number;
  /** Result of the awaited schedules sweep — undefined when `skipped`. */
  schedules?: ScheduleResult;
  /** Tick start time (epoch ms). */
  startMs: number;
}

export interface RunMaintenanceTickOptions {
  /**
   * Sweep even when the idle gate is armed. For the operator-facing `?force=1`
   * on the admin route and for anything that needs a guaranteed sweep; does not
   * bypass the overlap guard, which protects against concurrency rather than
   * repetition.
   */
  force?: boolean;
}

interface MaybeArmIdleGateInput {
  startMs: number;
  schedules: ScheduleResult;
  /** Did the schedules sweep fire anything (in any org)? */
  scheduleFoundWork: boolean;
  platformFoundWork: boolean;
}

/**
 * Decide whether this sweep earned the right to skip the next few ticks.
 *
 * Refuses to arm unless the sweep proved there is nothing to do: any task that
 * found something, any task that failed, a fired schedule, or a schedules sweep
 * that errored all leave the gate disarmed, because a tick that does not know
 * the state must not license skipping. Returns the skip-until time, or `0` when
 * the gate was left disarmed.
 *
 * Arming costs **one** indexed lookup (`getNextScheduleRunAt`), and only on the
 * sweep that arms — against the ~20 queries every skipped tick avoids.
 */
async function maybeArmIdleGate({
  startMs,
  schedules,
  scheduleFoundWork,
  platformFoundWork,
}: MaybeArmIdleGateInput): Promise<number> {
  const scheduleWork = 'error' in schedules || scheduleFoundWork;
  if (platformFoundWork || scheduleWork) {
    // Clears any horizon left over from an earlier arming, so the logs and the
    // gate agree.
    noteMaintenanceWork('maintenance-tick');
    return 0;
  }

  try {
    // A fork's own cadence bounds the gate — see `getAppJobsMinIntervalMs`.
    const appJobsMinIntervalMs = getAppJobsMinIntervalMs();
    let nextWorkAtMs = appJobsMinIntervalMs === null ? null : startMs + appJobsMinIntervalMs;

    // The earliest next run across EVERY org is a genuinely global read — the
    // one place the tick needs the audited bypass rather than an org scope.
    const nextRunAt = await runAsSystem('maintenance-tick: idle-gate horizon across all orgs', () =>
      getNextScheduleRunAt(new Date(startMs))
    );
    if (nextRunAt) {
      nextWorkAtMs = Math.min(nextWorkAtMs ?? Number.POSITIVE_INFINITY, nextRunAt.getTime());
    }

    return armIdleGate({ now: Date.now(), nextWorkAtMs });
  } catch (err) {
    // Not knowing the horizon is exactly the case where skipping is unsafe. The
    // catch also covers the gate itself: a bug in here must cost an extra sweep,
    // never the tick's completion log line.
    logger.warn('Maintenance tick: schedule horizon unavailable; leaving the idle gate disarmed', {
      error: err instanceof Error ? err.message : String(err),
    });
    noteMaintenanceWork('horizon-unavailable');
    return 0;
  }
}

/**
 * Run one maintenance tick. The schedules sweep is awaited; the rest of
 * the chain settles in the background under the overlap guard.
 */
export async function runMaintenanceTick(
  options: RunMaintenanceTickOptions = {}
): Promise<TickResult> {
  const startMs = Date.now();

  // First statement, before the overlap guard and before any Prisma call: the
  // whole point is that an idle tick costs zero database round-trips (#442).
  if (!options.force && shouldSkipIdleTick(startMs)) {
    const resumesAtMs = idleGateResumesAt();
    logger.info('Maintenance tick skipped — nothing due', {
      resumesAtMs,
      resumesInMs: resumesAtMs - startMs,
    });
    return { skipped: true, reason: 'idle', resumesAtMs, startMs };
  }

  if (tickRunning) {
    logger.info('Maintenance tick skipped — previous tick still running');
    return { skipped: true, reason: 'previous tick still running', startMs };
  }

  tickRunning = true;
  const myTickToken = ++currentTickToken;

  // Armed BEFORE the awaited sweep, not after it (§108 review round 2). The
  // guard is taken above; if the sweep itself never settles — a stalled pool
  // connection, a Prisma call that hangs — a watchdog armed after it is never
  // armed at all, and `tickRunning` stays true for the life of the process, so
  // every later tick reports "previous tick still running" and maintenance
  // stops for good. The sweep is now N sequential per-org passes, so its
  // duration scales with the org count and the window is wider than it was.
  const watchdogId = setTimeout(() => {
    if (currentTickToken !== myTickToken || !tickRunning) return;
    logger.warn('Maintenance tick: background chain exceeded max duration; releasing guard', {
      maxDurationMs: BACKGROUND_TASK_MAX_MS,
      tickStartMs: startMs,
    });
    tickRunning = false;
  }, BACKGROUND_TASK_MAX_MS);

  // One org-list read for the whole tick, handed to every per-org job below.
  // Without it each due job reads the same list again — the per-tick query
  // count #442 exists to hold down.
  let orgIds: readonly string[] | undefined;
  try {
    orgIds = await listActiveOrgIds();
  } catch {
    // Leave it undefined: each job falls back to reading the list itself, and
    // a job that also cannot read it fails in its own containment.
    orgIds = undefined;
  }

  let schedules: ScheduleResult;
  let scheduleFoundWork = false;
  try {
    // Per org: a due schedule's execution row, and everything the engine writes
    // for it afterwards, must carry the schedule's org.
    const outcome = await runScopedJob({
      name: 'schedules',
      scope: 'per-org',
      run: processDueSchedules,
      foundWork: (r) => r.processed > 0,
      orgIds,
    });
    schedules = outcome.result;
    scheduleFoundWork = outcome.foundWork;
  } catch (err) {
    schedules = { error: err instanceof Error ? err.message : String(err) };
  }

  void Promise.allSettled([
    // Sunrise's own tasks, each gated by its own minimum interval (#442) and
    // entering its own tenant scope (§108). The helper contains per-task
    // failures itself, so a rejection here would mean the registry rather than
    // a sweep.
    runDuePlatformJobs(startMs, orgIds),
    // Fork-owned seam (#469). Second so app work never delays Sunrise's own
    // maintenance. `runDueAppJobs` never throws and returns undefined when no
    // jobs are registered, so vanilla Sunrise is unaffected.
    runDueAppJobs(Date.now(), orgIds),
  ])
    .then(async ([platformResult, appJobsResult]) => {
      const platform =
        platformResult.status === 'fulfilled'
          ? platformResult.value
          : // A rejection here is the registry, not a sweep. Treat it as work so
            // the gate stays disarmed and the next tick looks again.
            { summary: { error: String(platformResult.reason) }, foundWork: true };
      // Only logged when the fork actually registered something, so the line
      // stays unchanged upstream.
      const appJobs =
        appJobsResult.status === 'fulfilled'
          ? appJobsResult.value
          : { error: String(appJobsResult.reason) };

      const idleUntilMs = await maybeArmIdleGate({
        startMs,
        schedules,
        scheduleFoundWork,
        platformFoundWork: platform.foundWork,
      });

      logger.info('Maintenance tick background tasks completed', {
        ...platform.summary,
        ...(appJobs ? { appJobs } : {}),
        ...(idleUntilMs > 0 ? { idleUntilMs } : {}),
        totalDurationMs: Date.now() - startMs,
      });
    })
    .finally(() => {
      clearTimeout(watchdogId);
      if (currentTickToken === myTickToken) {
        tickRunning = false;
      }
    });

  return { skipped: false, schedules, startMs };
}
