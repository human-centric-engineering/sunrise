/**
 * MCP progress tracker
 *
 * Wraps a long-running operation (a tools/call or resources/read) with a
 * `report(progress, total?)` callback that pushes
 * `notifications/progress { progressToken, progress, total }` to the
 * originating session's SSE stream.
 *
 * Per MCP 2025-06-18 spec, the client opts in by passing
 * `_meta.progressToken` on the request. Tokens are opaque to the server —
 * they round-trip verbatim — but we validate shape (string|number, ≤256
 * chars) and rate-limit the notification stream so a misbehaving capability
 * (or slow SSE consumer) can't blow up memory.
 *
 * Notifications are fire-and-forget: dropping a notification under rate
 * limit MUST NOT block the underlying operation. Progress is a UX hint,
 * not a correctness signal.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { logger } from '@/lib/logging';
import { getMcpSessionManager } from '@/lib/orchestration/mcp/singletons';

/** Max progress notifications per session per second (sliding window). */
const MAX_NOTIFICATIONS_PER_SEC = 50;
/** Width of the sliding window. */
const WINDOW_MS = 1000;
/** Max length of an opaque progress token (matches MCP spec recommendation). */
const MAX_TOKEN_LENGTH = 256;

/** Per-session timestamps of progress notifications, for the sliding window. */
const sentTimestamps = new Map<string, number[]>();

/** Reporter callback handed to capability code. */
export type ProgressReporter = (progress: number, total?: number) => void;

/**
 * Validate and normalise an MCP progress token from a request's `_meta`.
 *
 * Returns the token verbatim when valid, or `null` when no token was
 * supplied. Throws `RangeError` for invalid shapes — callers (the
 * protocol handler) translate this into `INVALID_PARAMS`.
 */
export function extractProgressToken(
  meta: Record<string, unknown> | undefined
): string | number | null {
  if (!meta || meta.progressToken === undefined || meta.progressToken === null) {
    return null;
  }
  const t = meta.progressToken;
  if (typeof t === 'string') {
    if (t.length === 0 || t.length > MAX_TOKEN_LENGTH) {
      throw new RangeError(`progressToken must be 1–${String(MAX_TOKEN_LENGTH)} chars`);
    }
    return t;
  }
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) {
      throw new RangeError('progressToken must be a finite number');
    }
    return t;
  }
  throw new RangeError('progressToken must be a string or number');
}

/**
 * Build a no-op reporter for callers that haven't opted into progress.
 * Capabilities that take a `progress` callback can use this so they don't
 * need a null-check on every report() call.
 */
export const NOOP_PROGRESS_REPORTER: ProgressReporter = () => {
  /* no-op */
};

/**
 * Create a progress reporter for a single tool / resource call.
 *
 * The reporter:
 *  - Pushes `notifications/progress` to only the originating session
 *    (never broadcasts to others).
 *  - Drops notifications over the per-session rate limit instead of
 *    queueing — backpressure is the wrong move when the operation
 *    itself shouldn't block.
 *  - Is safe to call after the session has expired or the SSE stream
 *    disconnected — the underlying manager swallows the write.
 *
 * Returns `NOOP_PROGRESS_REPORTER` when no `progressToken` was supplied,
 * so capability code can always call `progress(...)` without guarding.
 */
export function createProgressReporter(
  sessionId: string,
  token: string | number | null
): ProgressReporter {
  if (token === null) return NOOP_PROGRESS_REPORTER;

  return (progress: number, total?: number): void => {
    if (!Number.isFinite(progress)) {
      logger.warn('MCP progress: non-finite progress value, dropped', {
        sessionId,
        token,
        progress,
      });
      return;
    }
    if (total !== undefined && !Number.isFinite(total)) {
      logger.warn('MCP progress: non-finite total value, dropped', {
        sessionId,
        token,
        total,
      });
      return;
    }

    if (!allowAnotherNotification(sessionId)) {
      // Silently drop under rate limit. We deliberately do not log
      // each drop because a runaway capability could flood logs.
      return;
    }

    const params: Record<string, unknown> = { progressToken: token, progress };
    if (total !== undefined) {
      params.total = total;
    }

    getMcpSessionManager().broadcastNotification(
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params,
      },
      [sessionId]
    );
  };
}

/**
 * Sliding-window rate check. Returns true and records the timestamp when
 * a notification is allowed; returns false (without recording) when the
 * session has already sent MAX_NOTIFICATIONS_PER_SEC in the last 1 s.
 */
function allowAnotherNotification(sessionId: string): boolean {
  const now = Date.now();
  let stamps = sentTimestamps.get(sessionId);
  if (!stamps) {
    stamps = [];
    sentTimestamps.set(sessionId, stamps);
  }
  // Trim old entries that fell out of the window.
  const cutoff = now - WINDOW_MS;
  while (stamps.length > 0 && stamps[0] < cutoff) {
    stamps.shift();
  }
  if (stamps.length >= MAX_NOTIFICATIONS_PER_SEC) return false;
  stamps.push(now);
  return true;
}

/** Test helper — clears the per-session window state. */
export function _resetProgressTracker(): void {
  sentTimestamps.clear();
}
