/**
 * The idle gate — lets a maintenance tick decide to do **no database work at
 * all** (#442).
 *
 * Per-task intervals (`platform-jobs.ts`) cut how much a tick does. They cannot
 * fix the reported problem on their own: a scale-to-zero Postgres (Neon, Aurora
 * Serverless v2) autosuspends on compute *idle time*, so one query a minute
 * defeats a 5-minute timer exactly as well as twenty do. The tick has to be able
 * to skip **entirely**.
 *
 * ## Why skipping is sound rather than a guess
 *
 * Every latency-critical task's future work is announced by a timestamp column
 * that only a **request** can write:
 *
 *  - `AiWebhookDelivery.nextRetryAt` / `AiEventHookDelivery.nextRetryAt` — written
 *    by the dispatch paths, which also arm an in-process `setTimeout` that does
 *    the actual retry. The tick's drain is a crash-recovery backstop.
 *  - `AiWorkflowSchedule.nextRunAt` — written by an admin route, or by the
 *    scheduler when a schedule fires.
 *  - Queued evaluation runs and `pending` executions — created by a request.
 *
 * On a genuinely idle deployment there is no writer, so DB state cannot change
 * between ticks. Two mechanisms keep that reasoning honest:
 *
 *  1. **The horizon.** Arming takes the earliest known future work time, so the
 *     gate never skips past something that is already scheduled. A workflow
 *     schedule due in 40 seconds keeps firing on time.
 *  2. **The cap.** The gate re-verifies against the database at least every
 *     `MAINTENANCE_IDLE_MAX_SKIP_MS` (default 30 min), so anything this process
 *     could not observe — a write by another instance, a hand-edited row, an
 *     enqueue site that forgot to call `noteMaintenanceWork()` — is picked up
 *     within that bound rather than never.
 *
 * Set `MAINTENANCE_IDLE_MAX_SKIP_MS=0` to disable the gate: every tick then does
 * a full sweep, which is the pre-#442 behaviour.
 *
 * ## Per-process, and why it is not persisted
 *
 * State is in this process's memory. Persisting a `lastTickAt` would cost
 * exactly the query per tick that the gate exists to remove — and a
 * DB-backed "should I skip?" switch is self-defeating for the same reason.
 *
 * Consequences, all bounded by the cap: each instance keeps its own gate, and a
 * fresh instance starts **disarmed**, so a cold start always sweeps. Multi-instance
 * forks should lower the cap; the trade is documented in
 * `.context/orchestration/scheduling.md`.
 *
 * @see lib/orchestration/maintenance/run-tick.ts — the only caller of `armIdleGate`
 *
 * Tenancy posture: shared-by-decision — one horizon, because the tick sweeps
 * every org in one pass (lib/tenancy/process-state.ts).
 */

import { logger } from '@/lib/logging';

/** Default ceiling on how long the gate may skip before re-verifying. */
export const DEFAULT_MAX_SKIP_MS = 30 * 60 * 1000;

/**
 * Epoch ms before which ticks are skipped. `0` means disarmed — the next tick
 * does a full sweep.
 */
let skipUntilMs = 0;

/**
 * Resolved per call rather than at module load: `parseInt` at import time would
 * bake in whatever the environment looked like during the build.
 * Can be overridden via MAINTENANCE_IDLE_MAX_SKIP_MS; `0` disables the gate.
 */
function getMaxSkipMs(): number {
  const envValue = process.env.MAINTENANCE_IDLE_MAX_SKIP_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
    logger.warn('MAINTENANCE_IDLE_MAX_SKIP_MS is not a non-negative integer; using the default', {
      value: envValue,
      defaultMs: DEFAULT_MAX_SKIP_MS,
    });
  }
  return DEFAULT_MAX_SKIP_MS;
}

/** True when this tick can return without touching the database. */
export function shouldSkipIdleTick(now: number = Date.now()): boolean {
  return now < skipUntilMs;
}

/** Epoch ms of the next sweep, or `0` when the gate is disarmed. Observability only. */
export function idleGateResumesAt(): number {
  return skipUntilMs;
}

export interface ArmIdleGateInput {
  /** Tick start time. */
  now: number;
  /**
   * Earliest known future work, epoch ms — the next schedule fire, the shortest
   * registered app-job interval, whichever is sooner. `null` when nothing is
   * queued and only the cap applies.
   */
  nextWorkAtMs: number | null;
}

/**
 * Arm the gate after a sweep that found nothing to do.
 *
 * Never skips past known work and never skips longer than the cap, so the
 * failure mode is "sweeps more often than strictly necessary", never "misses
 * work". Returns the resolved skip-until time (`0` when the gate is disabled or
 * work is already due), for the caller's log line.
 */
export function armIdleGate({ now, nextWorkAtMs }: ArmIdleGateInput): number {
  const maxSkipMs = getMaxSkipMs();
  if (maxSkipMs === 0) {
    skipUntilMs = 0;
    return 0;
  }

  const cappedAt = now + maxSkipMs;
  const resolved = nextWorkAtMs === null ? cappedAt : Math.min(nextWorkAtMs, cappedAt);
  // Work already due (a horizon in the past) must not arm the gate at all,
  // otherwise `shouldSkipIdleTick` would still be false but the stored value
  // would be misleading in the logs.
  skipUntilMs = resolved > now ? resolved : 0;
  return skipUntilMs;
}

/**
 * Disarm the gate — the next tick does a full sweep.
 *
 * Call from any request path that creates work only the tick will pick up: a
 * queued evaluation run, a delivery with a `nextRetryAt`, a new or edited
 * schedule, a `pending` execution from a trigger. Cheap by construction (one
 * in-memory write), so calling it on a path that turns out not to need it costs
 * a single unnecessary sweep, while missing one costs up to the cap.
 */
export function noteMaintenanceWork(source?: string): void {
  if (skipUntilMs === 0) return;
  logger.debug('Maintenance idle gate disarmed', { source });
  skipUntilMs = 0;
}

/** Test-only: return the gate to its cold-start (disarmed) state. */
export function __resetIdleGateForTests(): void {
  skipUntilMs = 0;
}
