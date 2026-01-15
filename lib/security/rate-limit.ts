/**
 * Rate Limiting Utilities
 *
 * LRU cache-based sliding window rate limiter.
 * No external dependencies (Redis) required - suitable for single-server deployment.
 *
 * Features:
 * - Sliding window algorithm (more accurate than fixed windows)
 * - Memory-efficient with LRU eviction
 * - Pre-configured limiters for common use cases
 * - Rate limit headers for client feedback
 *
 * @example
 * ```typescript
 * import { authLimiter } from '@/lib/security/rate-limit';
 *
 * const result = authLimiter.check(clientIP);
 * if (!result.success) {
 *   return new Response('Too Many Requests', { status: 429 });
 * }
 * ```
 */

import { LRUCache } from 'lru-cache';
import { SECURITY_CONSTANTS } from './constants';

/**
 * Options for creating a rate limiter
 */
export interface RateLimitOptions {
  /** Time window in milliseconds */
  interval: number;
  /** Maximum requests allowed per interval */
  maxRequests: number;
  /** Maximum unique tokens to track (LRU eviction after this) */
  uniqueTokenPerInterval?: number;
}

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  success: boolean;
  /** Maximum requests allowed per interval */
  limit: number;
  /** Remaining requests in current window */
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  reset: number;
}

/**
 * Rate limiter instance with check and reset methods
 */
export interface RateLimiter {
  /** Check if a request is allowed for the given token (usually IP) */
  check: (token: string) => RateLimitResult;
  /** Reset the rate limit for a token (useful for testing or admin override) */
  reset: (token: string) => void;
  /** Get current stats for a token without consuming a request */
  peek: (token: string) => RateLimitResult;
}

/**
 * Create a rate limiter with sliding window algorithm
 *
 * @param options - Rate limit configuration
 * @returns Rate limiter instance
 *
 * @example
 * ```typescript
 * const limiter = createRateLimiter({
 *   interval: 60 * 1000, // 1 minute
 *   maxRequests: 10,
 *   uniqueTokenPerInterval: 500,
 * });
 *
 * const result = limiter.check('192.168.1.1');
 * console.log(result.remaining); // 9
 * ```
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { interval, maxRequests, uniqueTokenPerInterval } = options;

  // LRU cache stores array of request timestamps per token
  const cache = new LRUCache<string, number[]>({
    max: uniqueTokenPerInterval ?? SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
    ttl: interval,
  });

  /**
   * Get requests within the current sliding window
   */
  function getWindowRequests(token: string): number[] {
    const now = Date.now();
    const windowStart = now - interval;
    const requests = cache.get(token) ?? [];
    return requests.filter((time) => time > windowStart);
  }

  /**
   * Calculate reset time for headers
   */
  function getResetTime(): number {
    return Math.ceil((Date.now() + interval) / 1000);
  }

  return {
    check(token: string): RateLimitResult {
      const now = Date.now();
      const windowRequests = getWindowRequests(token);
      const currentCount = windowRequests.length;

      const success = currentCount < maxRequests;
      const remaining = Math.max(0, maxRequests - currentCount - (success ? 1 : 0));

      if (success) {
        // Add current request timestamp
        windowRequests.push(now);
        cache.set(token, windowRequests);
      }

      return {
        success,
        limit: maxRequests,
        remaining,
        reset: getResetTime(),
      };
    },

    reset(token: string): void {
      cache.delete(token);
    },

    peek(token: string): RateLimitResult {
      const windowRequests = getWindowRequests(token);
      const currentCount = windowRequests.length;

      return {
        success: currentCount < maxRequests,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - currentCount),
        reset: getResetTime(),
      };
    },
  };
}

// =============================================================================
// Pre-configured Rate Limiters
// =============================================================================

/**
 * Rate limiter for authentication endpoints (login, signup)
 * Limit: 5 requests per minute per IP
 *
 * @example
 * ```typescript
 * const result = authLimiter.check(request.ip);
 * if (!result.success) {
 *   logger.warn('Auth rate limit exceeded', { ip: request.ip });
 *   return rateLimitResponse(result);
 * }
 * ```
 */
export const authLimiter = createRateLimiter({
  interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
  maxRequests: SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.AUTH,
  uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
});

/**
 * Rate limiter for general API endpoints
 * Limit: 100 requests per minute per IP
 */
export const apiLimiter = createRateLimiter({
  interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
  maxRequests: SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.API,
  uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
});

/**
 * Rate limiter for password reset endpoint
 * Limit: 3 requests per 15 minutes per IP
 *
 * More restrictive due to potential for email bombing
 */
export const passwordResetLimiter = createRateLimiter({
  interval: SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.PASSWORD_RESET_INTERVAL,
  maxRequests: SECURITY_CONSTANTS.RATE_LIMIT.LIMITS.PASSWORD_RESET,
  uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
});

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Generate rate limit headers for HTTP response
 *
 * @param result - Rate limit check result
 * @returns Headers object to merge with response
 *
 * @example
 * ```typescript
 * const result = apiLimiter.check(ip);
 * const headers = getRateLimitHeaders(result);
 * return new Response(body, { headers });
 * ```
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  };
}

/**
 * Create a 429 Too Many Requests response
 *
 * @param result - Rate limit check result
 * @returns Response with proper headers and body
 *
 * @example
 * ```typescript
 * const result = authLimiter.check(ip);
 * if (!result.success) {
 *   return createRateLimitResponse(result);
 * }
 * ```
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  const retryAfterSeconds = Math.max(1, result.reset - Math.floor(Date.now() / 1000));

  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        ...getRateLimitHeaders(result),
      },
    }
  );
}
