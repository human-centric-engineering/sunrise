/**
 * Redis Rate Limit Store
 *
 * Atomic sliding window counter using Redis sorted sets and a Lua script.
 * Suitable for multi-server deployments where in-memory state would
 * diverge across instances.
 *
 * Requires the `ioredis` package. Set `RATE_LIMIT_STORE=redis` and
 * `REDIS_URL` to enable.
 */

import type { RateLimitStore, RateLimitStoreEntry } from '@/lib/security/rate-limit-stores/types';
import { logger } from '@/lib/logging';

/**
 * Lua script for atomic increment:
 * 1. Remove entries outside the sliding window
 * 2. Add the current timestamp as a scored set member (with unique suffix)
 * 3. Set TTL on the key to auto-expire
 * 4. Return the current count
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = window start timestamp (ms)
 * ARGV[2] = current timestamp (ms) — used as score
 * ARGV[3] = window duration (ms) — used for TTL
 * ARGV[4] = unique member suffix to avoid dedup under concurrency
 */
const INCREMENT_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[2] .. ':' .. ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return redis.call('ZCARD', KEYS[1])
`;

/**
 * Lua script for peek (no side effects):
 * 1. Remove expired entries
 * 2. Return the count
 */
const PEEK_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  return redis.call('ZCARD', KEYS[1])
`;

/** Minimal interface for the subset of ioredis methods we use */
interface RedisClient {
  eval(...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on(event: string, cb: (err: Error) => void): void;
}

let requestCounter = 0;

export class RedisRateLimitStore implements RateLimitStore {
  private client: RedisClient | null = null;
  private ready = false;
  private readonly initPromise: Promise<void>;

  constructor(redisUrl: string) {
    this.initPromise = this.init(redisUrl);
  }

  private async init(redisUrl: string): Promise<void> {
    try {
      // Dynamic import — ioredis is an optional peer dependency.
      // Both magic comments + the indirected specifier evade Turbopack /
      // webpack static resolution so the bundler does not warn when the
      // package is absent in dev. The runtime catch handles real failures.
      const moduleName = 'ioredis';
      const { default: Redis } = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ moduleName
      )) as typeof import('ioredis');
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      }) as unknown as RedisClient;
      this.client.on('error', (err: Error) => {
        logger.error('Redis rate limit store connection error', err);
      });
      this.ready = true;
      logger.info('Redis rate limit store connected', {
        url: redisUrl.replace(/\/\/.*@/, '//***@'),
      });
    } catch (err) {
      logger.error(
        'Failed to initialize Redis rate limit store — falling back will not work',
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  private async ensureReady(): Promise<void> {
    await this.initPromise;
    if (!this.ready || !this.client) {
      throw new Error('Redis rate limit store is not connected');
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitStoreEntry> {
    await this.ensureReady();
    const now = Date.now();
    const windowStart = now - windowMs;
    const uniqueSuffix = `${process.pid}-${++requestCounter}`;

    const count = (await this.client!.eval(
      INCREMENT_SCRIPT,
      1,
      `rl:${key}`,
      String(windowStart),
      String(now),
      String(windowMs),
      uniqueSuffix
    )) as number;

    return {
      count,
      resetAt: now + windowMs,
    };
  }

  async reset(key: string): Promise<void> {
    await this.ensureReady();
    await this.client!.del(`rl:${key}`);
  }

  async peek(key: string, windowMs: number): Promise<RateLimitStoreEntry | null> {
    await this.ensureReady();
    const now = Date.now();
    const windowStart = now - windowMs;

    const count = (await this.client!.eval(
      PEEK_SCRIPT,
      1,
      `rl:${key}`,
      String(windowStart)
    )) as number;

    if (count === 0) return null;
    return {
      count,
      resetAt: now + windowMs,
    };
  }
}
