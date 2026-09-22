/**
 * Sunrise's own recurring maintenance tasks, with a minimum interval each.
 *
 * Before #442 all eight ran on **every** tick. At the documented 60s cadence
 * that meant the retention sweep (whose windows are measured in days) ran 1,440
 * times a day and the embedding backfill full-scanned the message table just as
 * often. On a scale-to-zero Postgres (Neon, Aurora Serverless v2) the compute
 * never idles, so a deployment with no traffic bills as if it ran flat out.
 *
 * Each task now declares the shortest gap at which running it can still find
 * work. The intervals below are derived from each task's own thresholds, not
 * picked for taste — see the table in
 * `.context/orchestration/scheduling.md`.
 *
 * ## Every task declares whose rows it acts on (§108 t-711)
 *
 * A task's `scope` says which tenant context it runs in — see `job-scope.ts`
 * for the two values and why the default is per-org. Every task that touches
 * a tenant-owned table is `'per-org'`: it runs once per org inside that org's
 * scope, so its creates are stamped and, at `multi`, its reads and writes are
 * confined by the policies — the `take: 50` in a task body is a per-org cap.
 * Only the prune of the two system audit tables runs under the audited
 * `{ system }` scope. Before this, at `multi`, every task threw `No tenant
 * context` on its first query and nothing ran.
 *
 * ## Why not `registerAppJob`?
 *
 * The fork seam is keyed by name and documented as replace-on-re-register, so a
 * fork registering `retention` would silently disable Sunrise's own sweep. It
 * would also change what the already-shipped `getAppJobs()` returns. Platform
 * tasks therefore get their own table and their own clock.
 *
 * @see lib/orchestration/maintenance/run-tick.ts — the consumer
 * @see lib/orchestration/maintenance/job-clock.ts — the throttle mechanism
 * @see lib/orchestration/maintenance/app-jobs.ts — the fork-owned equivalent
 */

import { logger } from '@/lib/logging';
import { createJobClock } from '@/lib/orchestration/maintenance/job-clock';
import { runScopedJob, type JobScope } from '@/lib/orchestration/maintenance/job-scope';
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** What one task run reports back: its own summary value, plus "did it find anything". */
export interface PlatformJobOutcome {
  /** The task's return value, folded into the tick's completion log line. */
  result: unknown;
  /**
   * Did this run find anything? The idle gate (#442) refuses to arm when any
   * task says yes, because "found something" means either the deployment is
   * active or a batch cap left more behind.
   */
  foundWork: boolean;
}

/** A platform maintenance task and the shortest gap worth running it at. */
export interface PlatformJob {
  /** Stable name — appears in the tick's log line and in the route's `backgroundTasks`. */
  name: string;
  /** Minimum gap between starts, in ms. `0` means every tick. */
  intervalMs: number;
  /**
   * Whose rows the task acts on: once per org inside each org's scope, or once
   * under the audited system scope with the stated reason. Required — a
   * platform task with no declared scope is the state §108 removed.
   */
  scope: JobScope;
  /** Run the task inside its scope and classify its outcome. */
  run: () => Promise<PlatformJobOutcome>;
}

/**
 * Build a job entry. The generic keeps each `foundWork` predicate checked
 * against its own task's result type; `runScopedJob` evaluates it per org on
 * that type and ORs the answers, which is what lets `PlatformJob` erase the
 * type without a cast.
 */
function job<T>(spec: {
  name: string;
  intervalMs: number;
  scope: JobScope;
  run: () => Promise<T>;
  foundWork: (result: T) => boolean;
}): PlatformJob {
  return {
    name: spec.name,
    intervalMs: spec.intervalMs,
    scope: spec.scope,
    run: () =>
      runScopedJob({
        name: spec.name,
        scope: spec.scope,
        run: spec.run,
        foundWork: spec.foundWork,
      }),
  };
}

/**
 * Order is contract: the route publishes it as `backgroundTasks` and the
 * documented response shape lists it. Append, don't reorder.
 *
 * Intervals and scopes:
 *
 * | Task                      | Interval | Scope   | Why                                                                |
 * | ------------------------- | -------- | ------- | ------------------------------------------------------------------ |
 * | `webhookRetries`          | every    | per-org | backoff starts at 10s — throttling would miss the first retry       |
 * | `hookRetries`             | every    | per-org | same 10s/60s/300s backoff                                          |
 * | `orphanSweep`             | 2 min    | per-org | lease is 3 min, so a faster sweep provably finds nothing            |
 * | `zombieReaper`            | 5 min    | per-org | its own stale threshold is 30 min                                   |
 * | `embeddingBackfill`       | 15 min   | per-org | best-effort re-embed of a failed write; unindexed anti-join         |
 * | `retention`               | 1 hour   | per-org | windows are measured in days                                        |
 * | `pendingExecutionRecovery`| 2 min    | per-org | its own stale-pending threshold is 2 min                            |
 * | `evaluationRuns`          | every    | per-org | the worker drives one time-slice per tick, so cadence is throughput |
 * | `auditLogRetention`       | 1 hour   | system  | the two audit tables have no org; once, not once per org            |
 */
export const PLATFORM_JOBS: readonly PlatformJob[] = [
  job({
    name: 'webhookRetries',
    scope: 'per-org',
    intervalMs: 0,
    run: () => processPendingRetries(),
    foundWork: (retried) => retried > 0,
  }),
  job({
    name: 'hookRetries',
    scope: 'per-org',
    intervalMs: 0,
    run: () => processPendingHookRetries(),
    foundWork: (retried) => retried > 0,
  }),
  job({
    name: 'orphanSweep',
    scope: 'per-org',
    intervalMs: 2 * MINUTE,
    run: () => processOrphanedExecutions(),
    foundWork: (r) => r.recovered > 0 || r.exhausted > 0 || r.errors.length > 0,
  }),
  job({
    name: 'zombieReaper',
    scope: 'per-org',
    intervalMs: 5 * MINUTE,
    run: () => reapZombieExecutions(),
    foundWork: (r) => r.reaped > 0 || r.stalePending > 0 || r.abandonedApprovals > 0,
  }),
  job({
    name: 'embeddingBackfill',
    scope: 'per-org',
    intervalMs: 15 * MINUTE,
    run: () => backfillMissingEmbeddings(),
    // Batch-capped at 25, so any hit may mean more behind it.
    foundWork: (r) => r.processed > 0 || r.failed > 0,
  }),
  job({
    name: 'retention',
    scope: 'per-org',
    intervalMs: HOUR,
    run: () => enforceRetentionPolicies(),
    // Every prune is batch-capped too — a non-empty sweep is a reason to look
    // again rather than to go to sleep. `agentsProcessed` is excluded on
    // purpose: it counts agents *examined*, so any deployment with an agent
    // would report work forever and the gate could never arm.
    foundWork: (r) =>
      Object.entries(r).some(
        ([key, value]) => key !== 'agentsProcessed' && typeof value === 'number' && value > 0
      ),
  }),
  job({
    name: 'pendingExecutionRecovery',
    scope: 'per-org',
    intervalMs: 2 * MINUTE,
    run: () => processPendingExecutions(),
    foundWork: (r) => r.recovered > 0 || r.failed > 0 || r.errors.length > 0,
  }),
  job({
    name: 'evaluationRuns',
    scope: 'per-org',
    intervalMs: 0,
    // `claimed` means a run is mid-flight and needs the next tick's time-slice,
    // so this is the predicate that keeps the gate from stalling a batch eval.
    run: () => processPendingEvaluationRuns(),
    foundWork: (r) => r.claimed > 0,
  }),
  job({
    name: 'auditLogRetention',
    intervalMs: HOUR,
    // `AiAdminAuditLog` and `McpAuditLog` are system models — no org column, no
    // policy — so per org this would prune the same rows N times.
    scope: { system: 'auditLogRetention: prune the admin and MCP audit logs (system tables)' },
    run: () => enforceSystemRetentionPolicies(),
    foundWork: (r) => r.auditLogsDeleted > 0 || r.mcpAuditLogsDeleted > 0,
  }),
];

/**
 * Task names in table order. Re-exported by `run-tick.ts` as
 * `BACKGROUND_TASK_NAMES` and published by the tick route, so it is **derived**
 * rather than written out — the published list cannot drift from what runs. The
 * order itself is pinned by `platform-jobs.test.ts`.
 */
export const PLATFORM_JOB_NAMES: readonly string[] = PLATFORM_JOBS.map((entry) => entry.name);

/** Value written to the tick log line for a task held back by its interval. */
export const THROTTLED = 'skipped';

const clock = createJobClock();

/** Test-only: clear the throttle state so each test starts with every task due. */
export function __resetPlatformJobsForTests(): void {
  clock.reset();
}

export interface PlatformSweepResult {
  /** Per-task values for the tick's log line, keyed by task name. */
  summary: Record<string, unknown>;
  /**
   * True when any task that ran found something, or failed. Consumed by the
   * idle gate — see `armIdleGate`.
   */
  foundWork: boolean;
}

/**
 * Run every platform task whose interval has elapsed, in parallel.
 *
 * Never throws and never lets one task affect another — a rejection becomes
 * `{ error }` in the summary, which is what the tick's log line reports. Tasks
 * held back by their interval report `'skipped'` rather than being omitted, so
 * an operator can see the cadence working instead of wondering whether the sweep
 * ran.
 *
 * A rejection also counts as `foundWork`: an unknown outcome must not license
 * the idle gate to skip the next sweep.
 *
 * @param now Tick start time. Intervals measure start-to-start from this value.
 */
export async function runDuePlatformJobs(now: number = Date.now()): Promise<PlatformSweepResult> {
  const entries = await Promise.all(
    PLATFORM_JOBS.map(async (entry) => {
      if (!clock.isDue(entry.name, entry.intervalMs, now)) {
        // A throttled task says nothing either way about whether work exists.
        return [entry.name, THROTTLED, false] as const;
      }
      clock.markStarted(entry.name, now);
      try {
        const outcome = await entry.run();
        return [entry.name, outcome.result, outcome.foundWork] as const;
      } catch (err) {
        // Contained here rather than in `run-tick.ts` so one failing sweep can
        // never take down the whole summary line.
        logger.error('maintenance task failed', {
          task: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return [entry.name, { error: String(err) }, true] as const;
      } finally {
        clock.markSettled(entry.name);
      }
    })
  );

  const summary: Record<string, unknown> = {};
  let foundWork = false;
  for (const [name, result, taskFoundWork] of entries) {
    summary[name] = result;
    if (taskFoundWork) foundWork = true;
  }
  return { summary, foundWork };
}
