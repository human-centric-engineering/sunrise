/**
 * Execution lease — mutual exclusion for the engine driving an `AiWorkflowExecution`.
 *
 * The engine claims a lease when a run starts (or resumes) and refreshes it on every
 * checkpoint plus a periodic heartbeat. If the host driving the run dies, its lease
 * elapses; the orphan sweep `processOrphanedExecutions()` in `scheduling/scheduler.ts`
 * then re-claims the row and re-drives it through the standard resume path.
 *
 * Why a lease + heartbeat (not just a row-level "host_id"):
 *  - A simple host-id can't recover from the host going away — the row is stuck forever.
 *  - The lease gives a clear "is anyone driving this?" question with a time-bounded answer.
 *  - The heartbeat lets long single steps (multi-minute LLM calls, slow `external_call`)
 *    extend the lease without each executor having to opt in.
 *
 * Cadence rationale:
 *  - LEASE_DURATION_MS = 3 min. Long enough to absorb GC pauses and slow checkpoints, short
 *    enough that a crashed run is recoverable within ~4 min worst-case (lease + 60s sweep).
 *  - HEARTBEAT_INTERVAL_MS = 60 s. Three refreshes per lease window. A missed heartbeat
 *    (network blip) doesn't expire the lease.
 *
 * Single-instance deployment profile (per `.context/orchestration/meta/improvement-priorities.md`
 * Tier 4): no distributed leader election or coordination service is involved. Postgres row
 * UPDATEs serialise on the row, which is enough at this scale.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { WorkflowStatus } from '@/types/orchestration';

/**
 * Names of the lease lifecycle events recorded in
 * `AiWorkflowExecutionLeaseEvent`. The set is intentionally small —
 * each name maps to a distinct operator question:
 *
 *  - `claimed`        — a host successfully took the row
 *  - `refresh-failed` — a heartbeat tick couldn't extend the lease
 *  - `released`       — the engine cleanly handed the row back on terminal
 *  - `orphan-resume`  — the sweep re-claimed a row whose previous host
 *                       went silent (incl. recovery-attempts increment)
 *  - `force-failed`   — an admin terminated the run via the live-engine
 *                       force-fail action
 */
export type LeaseEventName =
  'claimed' | 'refresh-failed' | 'released' | 'orphan-resume' | 'force-failed';

/**
 * Reduce a full lease token to a short tail suitable for audit/inspector
 * display. The full token is a write-capability secret — anyone holding
 * it can write to the row via the engine's `where: { id, leaseToken }`
 * paths — so the inspector only ever shows the last 5 chars. Operators
 * correlate by tail; that's enough to answer "is this still the same
 * host?" without ever shipping the secret to the browser.
 */
export function redactLeaseToken(token: string | null | undefined): string | null {
  if (!token) return null;
  return token.length <= 5 ? `…${token}` : `…${token.slice(-5)}`;
}

/**
 * Append a row to `AiWorkflowExecutionLeaseEvent`. Fire-and-forget —
 * lease-event writes must never block the engine's critical path. A
 * dropped event is a missed inspector entry, not a correctness issue.
 */
async function recordLeaseEvent(
  executionId: string,
  event: LeaseEventName,
  token: string | null,
  reason?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.aiWorkflowExecutionLeaseEvent.create({
      data: {
        executionId,
        event,
        leaseToken: redactLeaseToken(token),
        reason: reason ?? null,
        metadata: metadata ? (metadata as object) : undefined,
      },
    });
  } catch (err) {
    logger.warn('Lease event write failed (non-fatal)', {
      executionId,
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const LEASE_DURATION_MS = 3 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * The execution-row identity + claim-token pair that authorises a write.
 *
 * The four engine DB-write paths (`markCurrentStep`, `checkpoint`, `pauseForApproval`,
 * `finalize`) match `where: { id, leaseToken }` so a stale-token holder's write silently
 * no-ops via `count: 0`. Packaging the two strings as one object inside a typed boundary
 * is a swap-bug guard: a misordered `markCurrentStep(stepId, executionId, leaseToken, …)`
 * (three strings in a row) would compile but fail at runtime as a silent no-op against the
 * wrong row. Wrapping them as `LeaseHandle` makes that mistake a compile error — `string`
 * is not assignable to `LeaseHandle`.
 *
 * The handle is engine-private. The executor surface (`ExecutionContext`) deliberately
 * does NOT carry it — executors are user-pluggable and have no business reading or
 * forging leases.
 */
export interface LeaseHandle {
  readonly executionId: string;
  readonly token: string;
}

export function generateLeaseToken(): string {
  return randomUUID();
}

export function leaseExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + LEASE_DURATION_MS);
}

/**
 * The two semantically-distinct reasons a host claims a lease on an existing row.
 *
 * - `'fresh-resume'`: the row was paused for approval and the user has just approved.
 *   Recovery is free — the user pause is a clean state boundary, not a crash signal.
 * - `'orphan-resume'`: the orphan sweep found a `running` row whose lease has expired
 *   (host died mid-step). This counts toward `MAX_RECOVERY_ATTEMPTS` so deterministic
 *   failures can't loop the sweep forever.
 *
 * Encoding the reason explicitly (rather than as an `incrementRecoveryAttempts` boolean)
 * makes call sites self-document — operators reading a stack trace see "orphan-resume"
 * and understand exactly which path is running.
 */
export type ClaimReason = 'fresh-resume' | 'orphan-resume';

/**
 * Resumable statuses for `fresh-resume`. `paused_for_approval` covers the pre-`executeApproval`
 * state (where a maintenance-tick-driven recovery sweep races the approve route); `pending`
 * covers the post-`executeApproval` state where the approve route has already written the
 * payload and flipped the row before kicking the resume helper. Both are valid starting
 * points for an approval-driven resume.
 *
 * Why a list, not a single status: `executeApproval` is the only place that transitions
 * `paused_for_approval → pending`, and it does so atomically alongside the trace update.
 * If `claimLease` accepted only one of the two, the resume path would race the approve
 * write in one direction or the other. Accepting both removes the race window without
 * weakening the terminal-row protection — the lease-coherence guard plus the reaper's
 * atomic lease-clear on FAILED transitions already handle that.
 */
const FRESH_RESUME_STATUSES = [WorkflowStatus.PAUSED_FOR_APPROVAL, WorkflowStatus.PENDING];

/**
 * Claim a lease on an execution row. Returns the new `leaseToken` on success, `null` when
 * another host already owns a fresh lease.
 *
 * Used by the resume path (`fresh-resume` after approval, `orphan-resume` after a crash).
 * Fresh runs claim their lease atomically in the row-create call inside `initRun`.
 *
 * Conditional UPDATE — only succeeds when (a) the row is in a resumable status (`running`
 * for orphan-resume, `paused_for_approval` or `pending` for fresh-resume) AND (b) the lease
 * is unclaimed (`leaseToken IS NULL`) or already expired (`leaseExpiresAt < now`). Postgres
 * serialises the UPDATE on the row, so two hosts racing on the same orphaned row will see
 * exactly one winner.
 *
 * Terminal rows (failed/completed/cancelled) are protected from resurrection by the
 * lease-coherence guard combined with the reaper's atomic lease-clear: `reapZombieExecutions`
 * writes `status: FAILED` AND `leaseToken: null, leaseExpiresAt: null` in the same
 * `updateMany`, so any subsequent `claimLease` on the FAILED row sees `leaseToken=null` but
 * also `status != expected` and can't take it. The status-allowlist (rather than a positive
 * status check) is what stops the FAILED row from being re-claimed even if a future change
 * forgets to clear the lease columns — defence in depth.
 *
 * `recoveryAttempts` is incremented only for `orphan-resume` — the `fresh-resume` path is a
 * clean state-machine transition that should not consume a recovery slot.
 */
export async function claimLease(executionId: string, reason: ClaimReason): Promise<string | null> {
  const now = new Date();
  const token = generateLeaseToken();
  const statusFilter =
    reason === 'orphan-resume' ? { equals: WorkflowStatus.RUNNING } : { in: FRESH_RESUME_STATUSES };
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: {
      id: executionId,
      status: statusFilter,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      leaseToken: token,
      leaseExpiresAt: leaseExpiry(now),
      lastHeartbeatAt: now,
      ...(reason === 'orphan-resume' ? { recoveryAttempts: { increment: 1 } } : {}),
    },
  });
  if (result.count === 1) {
    // Distinct event names per reason so the inspector can show
    // recovery cycles distinctly from clean approval resumes.
    void recordLeaseEvent(
      executionId,
      reason === 'orphan-resume' ? 'orphan-resume' : 'claimed',
      token,
      reason
    );
    return token;
  }
  return null;
}

/**
 * Extend the lease. Returns `true` if the caller still owns it, `false` if a different host
 * has taken over (token mismatch). The engine treats `false` as "stop driving this run" —
 * continuing would clobber the new owner's writes.
 *
 * Why match on `leaseToken` rather than just `id`: prevents a stale heartbeat from a
 * respawned-but-stale process from clobbering a fresh owner. Only the host that holds the
 * current token can refresh.
 */
export async function refreshLease(executionId: string, leaseToken: string): Promise<boolean> {
  const now = new Date();
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: { id: executionId, leaseToken },
    data: {
      leaseExpiresAt: leaseExpiry(now),
      lastHeartbeatAt: now,
    },
  });
  if (result.count === 0) {
    // Token mismatch — the previous host is no longer the owner. Record
    // so the inspector can show "lease lost at <time>" instead of a
    // silent gap. Successful refreshes are NOT recorded (they would
    // dominate the table by orders of magnitude vs. transitions).
    void recordLeaseEvent(executionId, 'refresh-failed', leaseToken, 'token-mismatch');
    return false;
  }
  return true;
}

/**
 * Release the lease on a terminal write. Today the engine's `finalize`
 * path nulls `leaseToken`/`leaseExpiresAt` itself; this helper exists
 * for non-engine terminations (admin force-fail, future bulk-abort) to
 * (a) clear the lease columns atomically with a single conditional
 * update and (b) record a `released` event so the inspector reflects
 * the transition.
 *
 * Conditional on `leaseToken IS NOT NULL` so calling on an already-
 * released row is a no-op (returns false) — keeps the event log honest.
 */
export async function releaseLease(executionId: string, reason: string): Promise<boolean> {
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: { id: executionId, leaseToken: { not: null } },
    data: { leaseToken: null, leaseExpiresAt: null },
  });
  if (result.count === 1) {
    void recordLeaseEvent(executionId, 'released', null, reason);
    return true;
  }
  return false;
}

/**
 * Record an externally-driven force-fail in the lease history.
 *
 * The admin force-fail route nulls the lease columns itself as part of
 * its single conditional UPDATE (so it can't race with the engine), so
 * this helper only writes the event — no lease mutation. Kept separate
 * from `releaseLease` so the inspector can distinguish "clean release"
 * from "admin terminated".
 */
export async function recordForceFailEvent(
  executionId: string,
  priorToken: string | null,
  reason: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordLeaseEvent(executionId, 'force-failed', priorToken, reason, metadata);
}

/**
 * Record a `released` event without mutating lease columns.
 *
 * Engine paths (`finalize`, `drainEngine` crash repair, the four
 * `processOrphanedExecutions` terminate paths, reaper sweep) all clear
 * `leaseToken` / `leaseExpiresAt` as part of their own conditional
 * UPDATE so the clear is atomic with the status flip. Calling
 * `releaseLease()` from there would be a second UPDATE that races —
 * worse, on the post-clear row it would always return false (the
 * WHERE leaseToken IS NOT NULL guard fails) and never record the
 * event. This helper is the right shape for that pattern: the column
 * mutation has already happened; we just want the inspector entry.
 *
 * `reason` should be short and operator-meaningful — e.g.
 * `'engine-terminal'`, `'crash-repair'`, `'recovery-exhausted'`,
 * `'reaper-sweep'`, `'workflow-deactivated'`. The inspector renders
 * it verbatim.
 */
export async function recordReleaseEvent(
  executionId: string,
  priorToken: string | null,
  reason: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await recordLeaseEvent(executionId, 'released', priorToken, reason, metadata);
}

/**
 * Cap on consecutive heartbeat refresh THROWS (not lease-lost — that's a separate signal).
 * After this many DB-throw refreshes in a row, the heartbeat self-cancels with an error log
 * rather than spinning forever. Set to 3 — roughly one lease window of failed refreshes,
 * after which the lease will expire naturally and the orphan sweep will recover.
 */
export const HEARTBEAT_FAILURE_CAP = 3;

/**
 * Start a periodic lease-refresh timer. Returns a function to clear the timer; call it
 * from `finally` so the timer is cleared even on early termination (cancellation, throw).
 *
 * The timer is `unref`'d so it never blocks process exit on its own.
 *
 * Self-cancel triggers:
 *  - `refreshLease` returns `false` (token mismatch — another host owns the row).
 *  - `refreshLease` throws `HEARTBEAT_FAILURE_CAP` consecutive times — bails on persistent
 *    DB failure rather than logging unboundedly. Any successful refresh resets the counter.
 *
 * Self-cancel atomicity: in Node's single-threaded event loop, `setInterval` callbacks
 * cannot interleave with synchronous code — so the `stopped = true; clearInterval(timer)`
 * pair runs as one unit. A queued tick that fires after `stopped = true` was set sees the
 * guard at the top of the callback and returns without touching the DB. The only race is
 * between an in-flight `refreshLease` Promise and a subsequent tick scheduling its own
 * `refreshLease` call — at most one extra DB call, which no-ops on the WHERE token.
 */
export function startHeartbeat(executionId: string, leaseToken: string): () => void {
  let stopped = false;
  let consecutiveFailures = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    refreshLease(executionId, leaseToken)
      .then((stillOwn) => {
        consecutiveFailures = 0;
        if (!stillOwn) {
          stopped = true;
          clearInterval(timer);
          logger.warn('Lease lost during heartbeat — another host has taken over', {
            executionId,
          });
        }
      })
      .catch((err) => {
        consecutiveFailures += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn('Lease heartbeat refresh failed', {
          executionId,
          consecutiveFailures,
          error: errorMessage,
        });
        if (consecutiveFailures >= HEARTBEAT_FAILURE_CAP) {
          stopped = true;
          clearInterval(timer);
          logger.error(
            `Lease heartbeat: giving up after ${HEARTBEAT_FAILURE_CAP} consecutive failures`,
            { executionId, error: errorMessage }
          );
        }
      });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
