/**
 * Rate Limit Store Factory
 *
 * Reads `RATE_LIMIT_STORE` env var to determine which backing store
 * to use for rate limit counters:
 * - `'memory'` (default) — in-process LRU cache
 * - `'redis'` — Redis sorted sets (requires `REDIS_URL`)
 *
 * All rate limiter instances share the same store via `getStore()`.
 */

import type { RateLimitStore } from '@/lib/security/rate-limit-stores/types';
import { MemoryRateLimitStore } from '@/lib/security/rate-limit-stores/memory';
import { logger } from '@/lib/logging';

export type { RateLimitStore, RateLimitStoreEntry } from '@/lib/security/rate-limit-stores/types';

let _store: RateLimitStore | null = null;

/**
 * Get the configured rate limit store (singleton).
 *
 * First call initializes the store based on `RATE_LIMIT_STORE` env var.
 * Subsequent calls return the same instance.
 */
export function getStore(): RateLimitStore {
  if (_store) return _store;

  const storeType = (process.env.RATE_LIMIT_STORE ?? 'memory').toLowerCase();

  if (storeType === 'redis') {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.warn('RATE_LIMIT_STORE=redis but REDIS_URL is not set — falling back to memory store');
      _store = new MemoryRateLimitStore();
      return _store;
    }

    // Dynamic import to avoid loading ioredis when not needed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RedisRateLimitStore } = require('@/lib/security/rate-limit-stores/redis') as {
      RedisRateLimitStore: new (url: string) => RateLimitStore;
    };
    _store = new RedisRateLimitStore(redisUrl);
    return _store;
  }

  _store = new MemoryRateLimitStore();
  return _store;
}

/**
 * Replace the global store instance — for tests only.
 */
export function setStore(store: RateLimitStore): void {
  _store = store;
}

/**
 * Reset the global store singleton — for tests only.
 */
export function resetStore(): void {
  _store = null;
}
