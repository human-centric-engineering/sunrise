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
 * Asking only whether the row still awaits a send (`pending` or `failed`)
 * could not tell the first of those from a manual retry, which reads the same. A stale timer then sent
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
 * claims first, with `updateManyAndReturn`, and sends the payload the claim
 * returned. Two of them racing for one row then send it once, and neither
 * sends a copy read before an erasure redacted it. A manual retry that resets
 * the row before a claim makes the claim miss. One that reads the row after a
 * claim still resets it, because a held lease and an armed retry both look
 * like a future `nextRetryAt`, and then both send: accepted, and documented in
 * data-erasure.md step 6. The attempt's own outcome write replaces the lease
 * with the real next retry time, or clears it.
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
 * was not written over that (t-793): an erasure stopped the row, or another
 * sender settled it, while this attempt was out. The send itself happened; the
 * row records it as an attempt, and this line says which outcome it had. (A
 * manual retry resets the row to `pending`, which still awaits a send, so an
 * attempt in flight across one writes its outcome as usual.)
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
