/**
 * When a webhook or event-hook delivery is sent again, and what it says when
 * it is not: the rules the webhook dispatcher and the hook registry share.
 *
 *   - `notRetried()`: the `lastError` wording for a row whose retry stopped
 *     (its subscription or hook was deleted, §109 t-739; an erasure, t-783).
 *     The real failure first, then why it was not retried: the row outlives
 *     its parent as the record of where an event went, so replacing the
 *     failure would lose why the delivery failed at all.
 *   - Which statuses still await a send, and the retry claim and its lease
 *     (t-793).
 *   - `DISPATCH_TIMEOUT_MS`: each channel's send timeout, held below the lease
 *     (t-808).
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

/**
 * Why erasure stopped a row whose payload names the erased person (t-783).
 * The wording goes on `lastError` for people to read; what a retry or a
 * replay refuses on is the row's `stoppedByErasure` column (t-809), which no
 * later `lastError` write can clear.
 */
export const SUBJECT_ERASED = 'subject erased';

/** Why erasure stopped an email delivery addressed to the erased person (t-786). */
export const RECIPIENT_ERASED = 'recipient erased';

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
 * attempt: every channel's send is bounded by {@link DISPATCH_TIMEOUT_MS},
 * which a test holds below this. Short enough that a process which claimed a
 * row and died hands it back to the maintenance tick.
 */
export const RETRY_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * How long one send may take, per delivery channel (t-808). An attempt that
 * outlived {@link RETRY_CLAIM_LEASE_MS} would leave its row's lease expired
 * while it was still out, and the next sender would claim the row and send it
 * a second time. So every channel's send is bounded, and a test fails if any
 * entry here reaches the lease. A new channel adds its entry here.
 *
 *   - `webhook`: a subscription's HTTP POST (`dispatcher.ts`);
 *   - `email`: a subscription's email, rendering and the Resend call together;
 *   - `hook`: an event hook's HTTP POST (`hooks/registry.ts`).
 */
export const DISPATCH_TIMEOUT_MS = {
  webhook: 5_000,
  email: 15_000,
  hook: 10_000,
} as const satisfies Record<string, number>;

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
