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
export function notRetried(lastError: string | null, reason: string): string {
  return lastError ? `${lastError} (not retried: ${reason})` : `Not retried: ${reason}`;
}

/**
 * The statuses of a delivery that will still be sent again — waiting on its
 * first attempt, or on a retry. An erasure stops a row in one of these
 * (§109 t-739, t-783); every place that asks "is this still going out?" reads
 * it from here, so a new retry status cannot be added to one and not the rest.
 */
export const AWAITING_RETRY_STATUSES: readonly string[] = ['pending', 'failed'];

/**
 * Whether a delivery is still waiting on its next attempt. An in-process retry
 * timer reads this before sending: a row settled while it waited — stopped by
 * an erasure (`exhausted`), or `delivered` — is left as it is, where a timer
 * that ignored it would send the row again and flip it back.
 *
 * It does not tell a timer's own row from one an admin retried by hand while
 * the timer waited: both read `pending` or `failed`, and the timer still sends.
 */
export function isAwaitingRetry(status: string): boolean {
  return AWAITING_RETRY_STATUSES.includes(status);
}
