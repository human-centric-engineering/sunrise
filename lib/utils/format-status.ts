/**
 * Sentence-case status label formatter for execution statuses.
 *
 * Provides both a generic formatter and a lookup record for known
 * execution statuses. All labels use sentence-case: "Paused for approval".
 */

/** Known execution status labels (sentence-case). */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused_for_approval: 'Paused for approval',
};

/**
 * Format a status string as sentence-case.
 *
 * Uses the `STATUS_LABELS` lookup when available; falls back to
 * replacing underscores with spaces and capitalising the first letter.
 */
export function formatStatus(status: string): string {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
