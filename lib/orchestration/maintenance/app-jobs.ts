/**
 * App recurring-job registry.
 *
 * Lets an app built on Sunrise run its own periodic work on the existing
 * maintenance tick — a nightly digest, a stale-cache sweep, a sync with an
 * external system — without standing up a second scheduler.
 *
 * Before this seam the scheduler ran workflow schedules only. An app's own
 * recurring job had nowhere to go: it either needed a separate cron process and
 * deployment target, or a fork had to edit `run-tick.ts` (a platform file, and a
 * merge conflict on every upstream sync).
 *
 * Jobs are keyed by `name`, so re-registration under HMR or repeated module
 * imports replaces rather than duplicates.
 *
 * ## Cadence is best-effort, and single-instance
 *
 * `intervalMs` is a **minimum** gap, not a guarantee. Two consequences worth
 * knowing before you rely on it:
 *
 *  1. Resolution is bounded by how often the tick itself runs (60s by default),
 *     so an `intervalMs` below that is effectively "every tick".
 *  2. Last-run times are tracked **in this process's memory**. A deployment with
 *     multiple instances runs each job roughly once per instance per interval,
 *     and a restart re-arms every job immediately. This mirrors the tick's own
 *     `tickRunning` guard, which is also per-process.
 *
 * So: fine for idempotent maintenance (sweeps, backfills, cache warming). Not a
 * distributed scheduler — if a job must run exactly once cluster-wide, it needs
 * its own lease, the way `execution-reaper` does.
 *
 * @see lib/orchestration/maintenance/run-tick.ts — the consumer
 * @see lib/app/jobs.ts — the fork-owned registration seam
 */

import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppJobs } from '@/lib/app/jobs';
import { createJobClock } from '@/lib/orchestration/maintenance/job-clock';

/** A unit of app-owned recurring work. */
export interface AppJob {
  /** Unique name. Re-registering the same name replaces the prior job. */
  name: string;
  /**
   * Minimum gap between runs, in milliseconds. Rounded up in practice to the
   * tick interval — see the cadence note above.
   */
  intervalMs: number;
  /**
   * The work. Return any JSON-serialisable summary and it is folded into the
   * tick's completion log line, so a job's outcome is visible without adding
   * its own logging.
   */
  run: () => Promise<unknown>;
}

const jobs = new Map<string, AppJob>();
/**
 * In-process start-to-start clock plus in-flight latch, keyed by job name. See
 * the cadence caveat above; the same mechanism throttles Sunrise's own tasks in
 * `platform-jobs.ts`.
 */
const clock = createJobClock();

/**
 * Register an app recurring job. Idempotent by `name` — re-registering replaces
 * the prior job (safe under HMR / repeated module imports). Call at
 * module-import time from `lib/app/jobs.ts`.
 */
export function registerAppJob(job: AppJob): void {
  if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
    // Rejected rather than defaulted: a job silently running every tick because
    // its interval was NaN is worse than a loud refusal at registration.
    logger.error('app-jobs: refusing to register a job with a non-positive intervalMs', {
      job: job.name,
      intervalMs: job.intervalMs,
    });
    return;
  }
  jobs.set(job.name, job);
}

/**
 * Run the fork's auto-wired init exactly once, lazily, rolling a partial init
 * back — see `lib/fork-init.ts` for the shared contract. A throwing init neither
 * retries every tick nor propagates out to fail the tick.
 */
const appInit = createAppInitGate({
  label: 'app-jobs: initAppJobs',
  // Rolled back, not just logged. A job registered before the throw would
  // otherwise run on EVERY tick, forever, from a config its author believes did
  // not load — and it would hold the tick's idle gate (#442) open at its
  // interval, so the cost is permanent rather than one-off.
  subject: 'app jobs',
  init: initAppJobs,
  snapshot: () => new Map(jobs),
  restore: (before) => restoreMap(jobs, before),
});

/** Test-only: drop all jobs, clear the clock, and re-arm the one-shot app init. */
export function __resetAppJobsForTests(): void {
  jobs.clear();
  clock.reset();
  appInit.reset();
}

/** Registered jobs, in first-registration order. Exposed for the admin surface. */
export function getAppJobs(): AppJob[] {
  appInit.ensure();
  return [...jobs.values()];
}

/**
 * Shortest interval any registered job asked for, or `null` when a fork has
 * registered none.
 *
 * Read by the tick's idle gate (#442): the gate must not skip further ahead than
 * a fork's own cadence, or a job registered at 5 minutes would quietly become a
 * 30-minute job. Registering any job therefore means this deployment is never
 * fully idle — which is what the fork asked for.
 */
export function getAppJobsMinIntervalMs(): number | null {
  appInit.ensure();
  let min: number | null = null;
  for (const job of jobs.values()) {
    if (min === null || job.intervalMs < min) min = job.intervalMs;
  }
  return min;
}

/**
 * Run every registered job whose interval has elapsed.
 *
 * Never throws, and never lets one job affect another: jobs run in parallel and
 * a rejection is logged and contained. Returns a per-job summary for the tick's
 * log line — `skipped` for jobs not yet due, so an operator can see the cadence
 * working rather than guessing.
 *
 * An empty registry short-circuits, so vanilla Sunrise pays nothing.
 */
export async function runDueAppJobs(
  now: number = Date.now()
): Promise<Record<string, unknown> | undefined> {
  appInit.ensure();
  if (jobs.size === 0) return undefined;

  const due = [...jobs.values()].filter((job) => clock.isDue(job.name, job.intervalMs, now));

  if (due.length === 0) return { skipped: jobs.size };

  const entries = await Promise.all(
    due.map(async (job) => {
      // Stamp before running, not after, so the interval measures start-to-start
      // rather than end-to-start.
      clock.markStarted(job.name, now);
      try {
        return [job.name, await job.run()] as const;
      } catch (err) {
        logger.error('app job failed', {
          job: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return [job.name, { error: err instanceof Error ? err.message : String(err) }] as const;
      } finally {
        clock.markSettled(job.name);
      }
    })
  );

  const summary: Record<string, unknown> = Object.fromEntries(entries);
  const skipped = jobs.size - due.length;
  if (skipped > 0) summary.skipped = skipped;
  return summary;
}
