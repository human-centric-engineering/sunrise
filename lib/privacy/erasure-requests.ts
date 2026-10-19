/**
 * Account deletion that survives the request it started in (t-842).
 *
 * `eraseUser()` can take minutes: its pre-passes redact in committed chunks,
 * and its transaction can queue behind a writer holding the person's lock for
 * up to about 13 minutes (t-840). A host with a short request limit can kill
 * the handler between the pre-passes and the transaction, which used to leave
 * a live account with part of its data already redacted, and nothing that
 * would finish the job.
 *
 * So a deletion is a request first:
 *
 *   1. **Record and disable, in one transaction, before any erasure work.**
 *      The intent goes on the `User` row (`erasureRequestedAt` and the rest),
 *      the person's sessions are deleted and their API keys revoked. From the
 *      commit on, sign-in is refused (`sessionCreateBeforeHook`).
 *   2. **Erase.** `eraseUser()` as before. Its delete takes the intent columns
 *      with the row, and its receipt is the record that the erasure finished.
 *   3. **Finish what did not.** `processPendingErasures()` runs on the
 *      maintenance tick and erases every person whose intent is still there
 *      once their next attempt is due.
 *
 * `erasureNextAttemptAt` is both a lease and a backoff. Each attempt claims the
 * row by moving it {@link ERASURE_LEASE_MS} ahead, conditional on the value it
 * read, so two retriers (or a retrier and a request) never run the same
 * erasure at once. A killed attempt leaves the lease to expire; a failed one
 * moves it to the backoff. Even if two attempts did overlap, the erasure
 * transaction takes the person's advisory locks and its delete is the row's
 * last write, so only one of them can write a receipt.
 *
 * A pending erasure cannot be cancelled (owner ruling, 2026-10-18): its
 * pre-passes may already have redacted data, and a cancelled account would be
 * left damaged.
 *
 * @see .context/privacy/data-erasure.md — "Pending erasures"
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';
import { eraseUser, type ErasureReason } from '@/lib/privacy/erase-user';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';

const MINUTE = 60 * 1000;

/**
 * How long one attempt holds a pending erasure before another may take it.
 * Longer than an erasure's worst case (about 13 minutes behind a writer
 * holding the person's lock, t-840), so a slow attempt is not joined by a
 * second; an attempt killed part-way is retried once it runs out.
 */
export const ERASURE_LEASE_MS = 20 * MINUTE;

/** The longest wait between attempts after a failure. Nothing gives up. */
export const ERASURE_MAX_BACKOFF_MS = 60 * MINUTE;

/**
 * Erasures one retrier run takes on. One: each can be long, the tick's chain
 * is bounded (5 minutes, and `maxDuration` on serverless), and two in one run
 * would hand the second a lease partly spent by the first. Erasures are rare,
 * so a backlog drains one a minute.
 */
export const ERASURES_PER_RUN = 1;

/** The wait before the next attempt, after `attempts` attempts have failed. */
export function erasureBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(MINUTE * 2 ** exponent, ERASURE_MAX_BACKOFF_MS);
}

export interface RequestUserErasureParams {
  /** The person to erase. */
  userId: string;
  /** Who asked: the person, or an admin. */
  actorUserId: string;
  reason: ErasureReason;
}

export type RequestUserErasureResult =
  | { status: 'erased'; receiptId: string; erasedAt: Date }
  /** Another attempt holds the lease; it, or the retrier, finishes the job. */
  | { status: 'in_progress'; requestedAt: Date };

/** What a claim found. */
type Claim =
  | {
      kind: 'claimed';
      actorUserId: string;
      reason: ErasureReason;
      attempts: number;
      /** The lease this claim wrote; the backoff write is conditional on it. */
      leaseUntil: Date;
    }
  | { kind: 'held'; requestedAt: Date }
  | { kind: 'gone' };

function asErasureReason(value: string | null): ErasureReason {
  return value === 'admin_action' ? 'admin_action' : 'self_service';
}

/** At `multi`, the audited system scope, as `eraseUser()` runs its own work. */
function inErasureScope<T>(userId: string, what: string, fn: () => Promise<T>): Promise<T> {
  return isMultiTenant() ? runAsSystem(`${what}: user ${userId}`, fn) : fn();
}

/**
 * Take the next attempt at a person's erasure and disable their account, in
 * one transaction.
 *
 * With `request`, a person with no pending erasure gets one recorded. Without
 * it (the retrier), only a pending one is taken. Either way it is taken only
 * when its next attempt is due by `dueBy`, by a write conditional on the lease
 * value read, so of two callers at once one gets `claimed` and the other
 * `held`. The lease itself runs from the moment of the claim, not from
 * `dueBy`, so it is never already partly spent.
 *
 * The account is disabled on every claim, not only the first, so a session
 * minted in the moment before the intent committed does not outlive the next
 * attempt.
 */
async function claimErasure(
  userId: string,
  dueBy: Date,
  request?: { actorUserId: string; reason: ErasureReason }
): Promise<Claim> {
  return inErasureScope(userId, 'claim a pending erasure', () =>
    prisma.$transaction(async (tx) => {
      const row = await tx.user.findUnique({
        where: { id: userId },
        select: {
          erasureRequestedAt: true,
          erasureRequestedBy: true,
          erasureReason: true,
          erasureAttempts: true,
          erasureNextAttemptAt: true,
        },
      });
      if (!row) return { kind: 'gone' } as const;
      const now = new Date();

      const pending = row.erasureRequestedAt !== null;
      if (!pending && !request) return { kind: 'gone' } as const;
      if (
        pending &&
        row.erasureNextAttemptAt !== null &&
        row.erasureNextAttemptAt.getTime() > dueBy.getTime()
      ) {
        return { kind: 'held', requestedAt: row.erasureRequestedAt ?? now } as const;
      }

      // Conditional on what was read: a second caller that read the same
      // values waits on this row's lock, then finds them changed and matches
      // nothing.
      const leaseUntil = new Date(now.getTime() + ERASURE_LEASE_MS);
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          erasureRequestedAt: row.erasureRequestedAt,
          erasureNextAttemptAt: row.erasureNextAttemptAt,
        },
        data: {
          // The first request is the one recorded; a repeat keeps it.
          ...(pending
            ? {}
            : {
                erasureRequestedAt: now,
                erasureRequestedBy: request?.actorUserId ?? null,
                erasureReason: request?.reason ?? null,
              }),
          erasureAttempts: { increment: 1 },
          erasureNextAttemptAt: leaseUntil,
        },
      });
      if (count === 0) {
        return { kind: 'held', requestedAt: row.erasureRequestedAt ?? now } as const;
      }

      // Disabled before any erasure work. API keys are revoked rather than
      // deleted: the erasure's cascade takes them, and until then a revoked key
      // is refused by `resolveApiKey` like any other.
      await tx.session.deleteMany({ where: { userId } });
      await tx.aiApiKey.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // The first request's actor and reason, as recorded.
      const requestedBy = pending ? row.erasureRequestedBy : (request?.actorUserId ?? null);
      // Always set by the claim that recorded the request. Should a row be
      // marked pending by hand without it, the person is named, as a
      // self-service erasure would name them.
      let actorUserId = requestedBy ?? userId;
      // The admin who asked may have been erased since. Their id cannot go on
      // the audit rows the erasure writes (a foreign key to `User`), and an
      // insert naming them would fail every attempt, for ever. The person is
      // named instead, so those rows lose their actor when the person's row
      // goes; the original actor stays in this log line.
      if (actorUserId !== userId) {
        const actor = await tx.user.findUnique({
          where: { id: actorUserId },
          select: { id: true },
        });
        if (!actor) {
          logger.warn('Pending erasure: the admin who asked has been erased; naming the person', {
            userId,
            requestedBy: actorUserId,
          });
          actorUserId = userId;
        }
      }
      return {
        kind: 'claimed',
        actorUserId,
        reason: asErasureReason(pending ? row.erasureReason : (request?.reason ?? null)),
        attempts: row.erasureAttempts + 1,
        leaseUntil,
      } as const;
    })
  );
}

/**
 * The receipt of a finished erasure of this person: their row is gone and a
 * receipt names them. Null while the row exists, and when it is gone with no
 * receipt — deleted some other way, which is logged, since nothing here can
 * erase it now.
 */
async function finishedErasure(
  userId: string
): Promise<{ receiptId: string; erasedAt: Date } | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (row) return null;
  const receipt = await prisma.dataErasureReceipt.findFirst({
    where: { subjectUserId: userId },
    orderBy: { erasedAt: 'desc' },
    select: { id: true, erasedAt: true },
  });
  if (!receipt) {
    logger.warn('Pending erasure: the user row is gone but no erasure receipt names it', {
      userId,
    });
    return null;
  }
  return { receiptId: receipt.id, erasedAt: receipt.erasedAt };
}

/** Run one claimed attempt. On failure, set the backoff and rethrow. */
async function attemptErasure(
  userId: string,
  claim: Extract<Claim, { kind: 'claimed' }>
): Promise<{ receiptId: string; erasedAt: Date }> {
  try {
    return await eraseUser({ userId, actorUserId: claim.actorUserId, reason: claim.reason });
  } catch (error) {
    // Another attempt may have finished it while this one ran (an expired
    // lease taken over): its delete is what this one tripped on.
    try {
      const finished = await finishedErasure(userId);
      if (finished) return finished;
    } catch {
      // Unknown: treat it as the failure it most likely is.
    }

    const nextAttemptAt = new Date(Date.now() + erasureBackoffMs(claim.attempts));
    try {
      // Only while this attempt's own lease stands: if it ran out and another
      // attempt has claimed the row since, its lease must not be cut short.
      await prisma.user.updateMany({
        where: { id: userId, erasureNextAttemptAt: claim.leaseUntil },
        data: { erasureNextAttemptAt: nextAttemptAt },
      });
    } catch (backoffError) {
      // The lease still runs out, so the retrier still gets to it: later.
      logger.error('Pending erasure: could not set the next attempt; the lease will expire', {
        userId,
        error: backoffError instanceof Error ? backoffError.message : String(backoffError),
      });
    }
    // The tick must not go idle past a pending erasure.
    noteMaintenanceWork('pending-erasure');
    logger.error('Erasure attempt failed; the maintenance tick retries it', {
      userId,
      attempts: claim.attempts,
      nextAttemptAt: nextAttemptAt.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Delete a person's account: record the intent and disable the account, then
 * erase them.
 *
 * Returns `erased` when the erasure finished here, and `in_progress` when
 * another attempt holds it (a repeated request, or the retrier). Throws when
 * this attempt's erasure fails; the intent stays recorded and the account
 * disabled, and `processPendingErasures()` finishes it. A request killed
 * part-way is finished the same way, once its lease runs out.
 *
 * Callers do their own authorization and last-admin checks first, as they did
 * before `eraseUser()`.
 */
export async function requestUserErasure(
  params: RequestUserErasureParams
): Promise<RequestUserErasureResult> {
  const { userId, actorUserId, reason } = params;
  const now = new Date();
  const claim = await claimErasure(userId, now, { actorUserId, reason });

  if (claim.kind === 'gone') {
    // Callers check the row exists first, so this is a race with another
    // erasure that just finished.
    const finished = await finishedErasure(userId);
    if (finished) return { status: 'erased', ...finished };
    throw new Error(`User ${userId} not found`);
  }
  if (claim.kind === 'held') {
    return { status: 'in_progress', requestedAt: claim.requestedAt };
  }

  // A pending erasure is maintenance work: the idle gate must not skip past
  // it, even if this request is killed before it can say anything else.
  noteMaintenanceWork('pending-erasure');
  logger.info('Erasure requested; account disabled', {
    userId,
    actorUserId,
    reason,
    attempts: claim.attempts,
  });

  return { status: 'erased', ...(await attemptErasure(userId, claim)) };
}

export interface ProcessPendingErasuresResult {
  /** Erasures this run took on. */
  claimed: number;
  /** Of those, finished. */
  erased: number;
  /** Of those, failed; each is retried after its backoff. */
  failed: number;
  /** Pending erasures still waiting after this run, due or not. */
  pending: number;
}

/**
 * The retrier: finish every pending erasure whose next attempt is due, up to
 * {@link ERASURES_PER_RUN} per run. Runs on the maintenance tick under the
 * system scope. Never throws for one person's failure; that person is retried
 * after their backoff.
 */
export async function processPendingErasures(
  now: Date = new Date()
): Promise<ProcessPendingErasuresResult> {
  const result: ProcessPendingErasuresResult = { claimed: 0, erased: 0, failed: 0, pending: 0 };
  const tried = new Set<string>();

  while (result.claimed < ERASURES_PER_RUN) {
    const due = await prisma.user.findFirst({
      where: {
        erasureRequestedAt: { not: null },
        OR: [{ erasureNextAttemptAt: { lte: now } }, { erasureNextAttemptAt: null }],
        id: { notIn: [...tried] },
      },
      // A row marked pending without a lease is the most overdue of all.
      orderBy: { erasureNextAttemptAt: { sort: 'asc', nulls: 'first' } },
      select: { id: true },
    });
    if (!due) break;
    tried.add(due.id);

    const claim = await claimErasure(due.id, now);
    // Taken by another instance between the read and the claim.
    if (claim.kind !== 'claimed') continue;

    result.claimed += 1;
    try {
      await attemptErasure(due.id, claim);
      result.erased += 1;
    } catch {
      // Logged, with its backoff set, by `attemptErasure`.
      result.failed += 1;
    }
  }

  result.pending = await prisma.user.count({ where: { erasureRequestedAt: { not: null } } });
  // Said here as well as through `foundWork`: a tick that finds this job
  // still running reports nothing for it, and must not arm the gate either.
  if (result.pending > 0) noteMaintenanceWork('pending-erasure');
  return result;
}
