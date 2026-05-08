/**
 * Execution lease — mutual exclusion for the engine driving an `AiWorkflowExecution`.
 *
 * The engine claims a lease when a run starts (or resumes) and refreshes it on every
 * checkpoint plus a periodic heartbeat. If the host driving the run dies, its lease
 * elapses; the orphan sweep in `execution-reaper.ts` then re-claims the row and re-drives
 * it through the standard resume path.
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

export const LEASE_DURATION_MS = 3 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function generateLeaseToken(): string {
  return randomUUID();
}

export function leaseExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + LEASE_DURATION_MS);
}

/**
 * Claim a lease on an execution row. Returns the new `leaseToken` on success, `null` when
 * another host already owns a fresh lease.
 *
 * Used by the resume path (approval-resume and orphan re-drive). Fresh runs claim their
 * lease atomically in the row-create call inside `initRun`.
 *
 * Conditional UPDATE — only succeeds when the lease is unclaimed (`leaseToken IS NULL`)
 * or already expired (`leaseExpiresAt < now`). Postgres serialises the UPDATE on the row,
 * so two hosts racing on the same orphaned row will see exactly one winner.
 */
export async function claimLease(
  executionId: string,
  options?: { incrementRecoveryAttempts?: boolean }
): Promise<string | null> {
  const now = new Date();
  const token = generateLeaseToken();
  const result = await prisma.aiWorkflowExecution.updateMany({
    where: {
      id: executionId,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      leaseToken: token,
      leaseExpiresAt: leaseExpiry(now),
      lastHeartbeatAt: now,
      ...(options?.incrementRecoveryAttempts ? { recoveryAttempts: { increment: 1 } } : {}),
    },
  });
  return result.count === 1 ? token : null;
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
  return result.count === 1;
}

/**
 * Clear the lease. Called on `finalize()` and `pauseForApproval()` — the row is no longer
 * being driven. Token-scoped so a stale clear from a crashed process can't strip a new
 * owner's lease. Failure to clear is logged but not fatal — the row will tip into terminal
 * state regardless and the lease will expire naturally.
 */
export async function releaseLease(executionId: string, leaseToken: string): Promise<void> {
  try {
    await prisma.aiWorkflowExecution.updateMany({
      where: { id: executionId, leaseToken },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  } catch (err) {
    logger.warn('Lease release failed', {
      executionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start a periodic lease-refresh timer. Returns a function to clear the timer; call it
 * from `finally` so the timer is cleared even on early termination (cancellation, throw).
 *
 * The timer is `unref`'d so it never blocks process exit on its own.
 *
 * Loss-of-ownership handling: if `refreshLease` returns false, the heartbeat self-cancels.
 * The engine still detects the loss on its next checkpoint via the same `where: { leaseToken }`
 * guard and aborts cleanly.
 */
export function startHeartbeat(executionId: string, leaseToken: string): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    refreshLease(executionId, leaseToken)
      .then((stillOwn) => {
        if (!stillOwn) {
          stopped = true;
          clearInterval(timer);
          logger.warn('Lease lost during heartbeat — another host has taken over', {
            executionId,
          });
        }
      })
      .catch((err) => {
        logger.warn('Lease heartbeat refresh failed', {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
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
