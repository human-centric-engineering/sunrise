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
