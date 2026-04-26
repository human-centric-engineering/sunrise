/**
 * Duration formatting for execution UI.
 *
 * Accepts two ISO date strings (start/end) and returns a human-readable
 * duration. When `end` is null, uses the current time (for running
 * executions). Returns `'—'` for invalid or missing start dates.
 */

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(startMs)) return '—';
  const ms = endMs - startMs;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
