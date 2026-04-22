/**
 * Rate Limit Store Interface
 *
 * Abstracts the backing store for rate limit counters. Implementations
 * must be safe for concurrent access within their deployment model:
 * - `MemoryRateLimitStore` — single-server, in-process LRU cache
 * - `RedisRateLimitStore` — multi-server, Redis-backed atomic counters
 */

export interface RateLimitStoreEntry {
  /** Number of requests in the current window */
  count: number;
  /** Unix timestamp (ms) when the window resets */
  resetAt: number;
}

export interface RateLimitStore {
  /**
   * Record a request and return the updated count.
   *
   * @param key - Unique rate limit key (e.g., `auth:192.168.1.1`)
   * @param windowMs - Sliding window duration in milliseconds
   * @returns Current count and window reset time
   */
  increment(key: string, windowMs: number): Promise<RateLimitStoreEntry>;

  /**
   * Reset the counter for a key.
   */
  reset(key: string): Promise<void>;

  /**
   * Read the current count without incrementing.
   *
   * @returns Entry if the key exists and has active requests, or null
   */
  peek(key: string, windowMs: number): Promise<RateLimitStoreEntry | null>;
}
