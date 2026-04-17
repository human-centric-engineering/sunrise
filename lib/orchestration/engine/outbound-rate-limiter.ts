/**
 * Outbound rate limiter for `external_call` steps.
 *
 * Prevents workflows from overwhelming external APIs by enforcing
 * per-host sliding-window rate limits. Also respects `Retry-After`
 * headers returned by upstream APIs.
 *
 * Default: 60 requests per minute per host. Configurable via
 * `ORCHESTRATION_OUTBOUND_RATE_LIMIT` env var (requests/minute).
 *
 * NOTE: Per-instance in-memory state (matching the circuit-breaker
 * pattern). In a multi-instance deployment, each container tracks
 * independently. For coordinated rate limiting, back with Redis.
 */

import { createRateLimiter, type RateLimiter } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';

const WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

/** Tracks per-host Retry-After backoff deadlines. */
const retryAfterDeadlines = new Map<string, number>();

/** Per-host rate limiter instances. */
const hostLimiters = new Map<string, RateLimiter>();

function getMaxRequestsPerMinute(): number {
  const envVal = process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_REQUESTS_PER_MINUTE;
}

function getLimiterForHost(hostname: string): RateLimiter {
  const existing = hostLimiters.get(hostname);
  if (existing) return existing;
  const limiter = createRateLimiter({
    interval: WINDOW_MS,
    maxRequests: getMaxRequestsPerMinute(),
    uniqueTokenPerInterval: 200,
  });
  hostLimiters.set(hostname, limiter);
  return limiter;
}

export interface OutboundRateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

/**
 * Check whether a request to `hostname` is allowed.
 *
 * Returns `{ allowed: false, retryAfterMs }` when the host is either
 * rate-limited or still in a Retry-After backoff window.
 */
export function checkOutboundRateLimit(hostname: string): OutboundRateLimitResult {
  const now = Date.now();

  // Check Retry-After backoff first.
  const deadline = retryAfterDeadlines.get(hostname);
  if (deadline && now < deadline) {
    return { allowed: false, retryAfterMs: deadline - now };
  }
  // Deadline passed — clean up.
  if (deadline) retryAfterDeadlines.delete(hostname);

  const limiter = getLimiterForHost(hostname);
  const result = limiter.check(hostname);
  if (!result.success) {
    const retryAfterMs = Math.max(1000, result.reset * 1000 - now);
    logger.warn('Outbound rate limit exceeded', {
      hostname,
      limit: result.limit,
      retryAfterMs,
    });
    return { allowed: false, retryAfterMs };
  }

  return { allowed: true };
}

/**
 * Record a `Retry-After` directive from an upstream API response.
 *
 * Accepts either seconds (number) or an HTTP-date string per RFC 7231.
 */
export function recordRetryAfter(hostname: string, retryAfterHeader: string): void {
  const seconds = parseInt(retryAfterHeader, 10);
  let deadlineMs: number;

  if (!Number.isNaN(seconds)) {
    deadlineMs = Date.now() + seconds * 1000;
  } else {
    // Try parsing as HTTP-date.
    const date = Date.parse(retryAfterHeader);
    if (Number.isNaN(date)) return;
    deadlineMs = date;
  }

  const existing = retryAfterDeadlines.get(hostname);
  if (!existing || deadlineMs > existing) {
    retryAfterDeadlines.set(hostname, deadlineMs);
    logger.info('Recorded Retry-After backoff', {
      hostname,
      deadlineMs,
      retryAfterHeader,
    });
  }
}

/** Reset all state. For tests only. */
export function resetOutboundRateLimiters(): void {
  hostLimiters.clear();
  retryAfterDeadlines.clear();
}
