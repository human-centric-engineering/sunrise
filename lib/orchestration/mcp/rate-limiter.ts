/**
 * MCP Rate Limiter
 *
 * Per-key rate limiting wrapping the existing createRateLimiter utility.
 * Lazily creates per-key instances keyed by apiKeyId.
 *
 * Platform-agnostic: no Next.js imports.
 */

import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from '@/lib/security/rate-limit';

const WINDOW_MS = 60_000; // 1 minute

export class McpRateLimiter {
  private limiters = new Map<string, { limiter: RateLimiter; maxRequests: number }>();

  /**
   * Check rate limit for a given API key.
   *
   * @param apiKeyId - The API key identifier
   * @param maxRequests - Requests per minute allowed for this key
   */
  check(apiKeyId: string, maxRequests: number): RateLimitResult {
    const entry = this.limiters.get(apiKeyId);

    if (entry && entry.maxRequests === maxRequests) {
      return entry.limiter.check(apiKeyId);
    }

    // Create or replace limiter if max changed
    const limiter = createRateLimiter({
      interval: WINDOW_MS,
      maxRequests,
    });
    this.limiters.set(apiKeyId, { limiter, maxRequests });
    return limiter.check(apiKeyId);
  }

  /** Reset all limiters (for testing) */
  clear(): void {
    this.limiters.clear();
  }
}
