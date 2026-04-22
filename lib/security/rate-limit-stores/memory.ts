/**
 * In-Memory Rate Limit Store
 *
 * LRU cache-based sliding window implementation. Suitable for
 * single-server deployments. This is the default store when no
 * `RATE_LIMIT_STORE` env var is set.
 */

import { LRUCache } from 'lru-cache';
import type { RateLimitStore, RateLimitStoreEntry } from '@/lib/security/rate-limit-stores/types';
import { SECURITY_CONSTANTS } from '@/lib/security/constants';

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly cache: LRUCache<string, number[]>;

  constructor(maxKeys?: number) {
    this.cache = new LRUCache<string, number[]>({
      max: maxKeys ?? SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
      // No global TTL — we manage expiry per-key via windowMs
    });
  }

  increment(key: string, windowMs: number): Promise<RateLimitStoreEntry> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const requests = (this.cache.get(key) ?? []).filter((t) => t > windowStart);
    requests.push(now);
    this.cache.set(key, requests, { ttl: windowMs });
    return Promise.resolve({
      count: requests.length,
      resetAt: now + windowMs,
    });
  }

  reset(key: string): Promise<void> {
    this.cache.delete(key);
    return Promise.resolve();
  }

  peek(key: string, windowMs: number): Promise<RateLimitStoreEntry | null> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const raw = this.cache.get(key);
    if (!raw) return Promise.resolve(null);
    const requests = raw.filter((t) => t > windowStart);
    if (requests.length === 0) return Promise.resolve(null);
    return Promise.resolve({
      count: requests.length,
      resetAt: now + windowMs,
    });
  }
}
