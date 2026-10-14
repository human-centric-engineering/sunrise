/**
 * The `lastError` for a webhook or event-hook delivery whose retry stopped
 * because its subscription or hook was deleted (§109 t-739).
 *
 * The real failure first, then why it was not retried. The row outlives its
 * parent as the record of where an event went, so replacing the failure with
 * the reason the retries stopped would lose why the delivery failed at all.
 *
 * Platform-agnostic: no Next.js imports.
 */
import { logger } from '@/lib/logging';

export function notRetried(lastError: string | null, reason: string): string {
  return lastError ? `${lastError}${notRetriedSuffix(reason)}` : `Not retried: ${reason}`;
}

/** What {@link notRetried} appends to a row that already had an error. */
export function notRetriedSuffix(reason: string): string {
  return ` (not retried: ${reason})`;
}

/** Why erasure stopped a row whose payload names the erased person (t-783). */
export const SUBJECT_ERASED = 'subject erased';

/** Why erasure stopped an email delivery addressed to the erased person (t-786). */
export const RECIPIENT_ERASED = 'recipient erased';

const ERASURE_REASONS: readonly string[] = [SUBJECT_ERASED, RECIPIENT_ERASED];

/**
 * Whether erasure stopped this row: its `lastError` is {@link notRetried}'s
 * wording for one of the erasure reasons. A manual retry or a replay refuses
 * such a row (t-793). What it would send is about a person who has been
 * erased, or goes to their address.
 *
 * Read from `lastError` because that is the only mark an erasure leaves. The
 * row keeps its status vocabulary, so `exhausted` alone cannot tell an erased
 * row from one that ran out of attempts.
 */
export function isStoppedByErasure(lastError: string | null): boolean {
  if (!lastError) return false;
  return ERASURE_REASONS.some(
    (reason) =>
      lastError === notRetried(null, reason) || lastError.endsWith(notRetriedSuffix(reason))
  );
}

/**
 * The statuses of a delivery that will still be sent again — waiting on its
 * first attempt, or on a retry. An erasure stops a row in one of these
 * (§109 t-739, t-783); every place that asks "is this still going out?" reads
 * it from here, so a new retry status cannot be added to one and not the rest.
 */
export const AWAITING_RETRY_STATUSES: readonly string[] = ['pending', 'failed'];

/**
 * Whether a delivery is still waiting on its next attempt. An attempt writes
 * its outcome only to a row that still is (t-793). A row settled while the
 * attempt was in flight — stopped by an erasure (`exhausted`), or `delivered`
 * — is left as it is. Otherwise the attempt would flip it back and arm another
 * send.
 */
export function isAwaitingRetry(status: string): boolean {
  return AWAITING_RETRY_STATUSES.includes(status);
}

/**
 * Whether an in-process retry timer's row is still the retry it was armed
 * for: `failed`, with the `nextRetryAt` the failed attempt wrote when it armed
 * the timer (t-793). Anything else means the row moved on while the timer
 * waited, and the timer must not send:
 *
 *   - stopped by an erasure, or delivered;
 *   - an admin retried it by hand, which resets it to `pending`, and if that
 *     attempt fails, writes a new `nextRetryAt` and arms its own timer;
 *   - the maintenance tick, or another timer, claimed it
 *     ({@link claimArmedRetry}).
 *
 * {@link isAwaitingRetry} alone could not tell the first of those from a
 * manual retry, which read `pending` or `failed` too. A stale timer then sent
 * the row a second time. This is the cheap check before the claim; the claim
 * is what settles a race.
 */
export function isArmedRetry(
  row: { status: string; nextRetryAt: Date | null },
  armedFor: Date
): boolean {
  return row.status === 'failed' && row.nextRetryAt?.getTime() === armedFor.getTime();
}

/**
 * How far a claimed retry's `nextRetryAt` moves on. Long enough for any one
 * attempt (the dispatch timeouts are seconds). Short enough that a process
 * which claimed a row and died hands it back to the maintenance tick.
 */
export const RETRY_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * The `updateMany` arguments that claim a `failed` row's due retry (t-793).
 * They match only the row as the sender read it, `failed` with that
 * `nextRetryAt`, and move `nextRetryAt` on by {@link RETRY_CLAIM_LEASE_MS}.
 * Every sender of a due retry (the in-process timer, the maintenance tick)
 * claims first and sends only on `count === 1`. Two of them racing for one
 * row then send it once. A manual retry's reset matches `nextRetryAt` too, so
 * it loses to a claim and a claim loses to it. The attempt's own outcome write
 * replaces the lease with the real next retry time, or clears it.
 */
export function claimArmedRetry(
  id: string,
  armedFor: Date,
  now: Date = new Date()
): {
  where: { id: string; status: 'failed'; nextRetryAt: Date };
  data: { nextRetryAt: Date };
} {
  return {
    where: { id, status: 'failed', nextRetryAt: armedFor },
    data: { nextRetryAt: new Date(now.getTime() + RETRY_CLAIM_LEASE_MS) },
  };
}

/**
 * An attempt finished after its row stopped awaiting a send, and its outcome
 * was not written over that (t-793). An erasure stopped the row, or an admin
 * retried it by hand while this attempt was out. The send itself happened; the
 * row records it as an attempt, and this line says which outcome it had.
 */
export function logSettledInFlight(
  kind: 'Webhook' | 'Hook',
  deliveryId: string,
  outcome: 'delivered' | 'failed'
): void {
  logger.info(`${kind} delivery outcome not recorded: the row was settled while in flight`, {
    deliveryId,
    outcome,
  });
}
