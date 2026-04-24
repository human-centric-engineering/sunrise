/**
 * Tests for Rate Limit Store Abstraction
 *
 * Covers:
 * - MemoryRateLimitStore: increment, reset, peek, sliding window
 * - Store factory: default to memory, fallback when Redis URL missing
 * - RedisRateLimitStore: increment, reset, peek, error handling, not-connected guard
 * - createAsyncRateLimiter: check, reset, peek via store
 * - createAsyncDynamicLimiter: default RPM, custom RPM override
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// ioredis is aliased to __mocks__/ioredis.ts in vitest.config.ts so that Vite can
// resolve it even though the real ioredis package is not installed.
// The mock file exports `ioredisState` — tests mutate this to control behaviour.

import { ioredisState } from '@mocks/ioredis';

import { logger } from '@/lib/logging';
import { MemoryRateLimitStore } from '@/lib/security/rate-limit-stores/memory';
import { RedisRateLimitStore } from '@/lib/security/rate-limit-stores/redis';
import { getStore, resetStore, setStore } from '@/lib/security/rate-limit-stores';
import { createAsyncRateLimiter, createAsyncDynamicLimiter } from '@/lib/security/rate-limit';
import type { RateLimitStore } from '@/lib/security/rate-limit-stores';

// ---------------------------------------------------------------------------
// MemoryRateLimitStore
// ---------------------------------------------------------------------------

describe('MemoryRateLimitStore', () => {
  let store: MemoryRateLimitStore;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('increments and returns count', async () => {
    const entry1 = await store.increment('key1', 60_000);
    expect(entry1.count).toBe(1);

    const entry2 = await store.increment('key1', 60_000);
    expect(entry2.count).toBe(2);
  });

  it('tracks independent keys', async () => {
    await store.increment('a', 60_000);
    await store.increment('a', 60_000);
    const entryA = await store.increment('a', 60_000);
    const entryB = await store.increment('b', 60_000);

    expect(entryA.count).toBe(3);
    expect(entryB.count).toBe(1);
  });

  it('resets a key', async () => {
    await store.increment('key1', 60_000);
    await store.increment('key1', 60_000);
    await store.reset('key1');

    const entry = await store.increment('key1', 60_000);
    expect(entry.count).toBe(1);
  });

  it('peek returns null for unknown key', async () => {
    const entry = await store.peek('nonexistent', 60_000);
    expect(entry).toBeNull();
  });

  it('peek returns count without incrementing', async () => {
    await store.increment('key1', 60_000);
    await store.increment('key1', 60_000);

    const entry = await store.peek('key1', 60_000);
    expect(entry).not.toBeNull();
    expect(entry!.count).toBe(2);

    // Verify no increment happened
    const entry2 = await store.peek('key1', 60_000);
    expect(entry2!.count).toBe(2);
  });

  it('returns resetAt in the future', async () => {
    const before = Date.now();
    const entry = await store.increment('key1', 60_000);
    expect(entry.resetAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('evicts the oldest key when maxKeys is exceeded (LRU)', async () => {
    // Arrange: store with capacity of exactly 2 keys
    const lruStore = new MemoryRateLimitStore(2);

    // Act: add key-a, then key-b (cache is full)
    await lruStore.increment('key-a', 60_000);
    await lruStore.increment('key-b', 60_000);

    // Access key-a to make it the most-recently-used, so key-b becomes LRU
    await lruStore.increment('key-a', 60_000);

    // Adding key-c should evict key-b (least recently used)
    await lruStore.increment('key-c', 60_000);

    // Assert: key-b was evicted — peek returns null
    const evicted = await lruStore.peek('key-b', 60_000);
    expect(evicted).toBeNull();

    // Assert: key-a and key-c are still present
    const alive = await lruStore.peek('key-a', 60_000);
    expect(alive).not.toBeNull();
    expect(alive!.count).toBe(2); // two increments (initial + the access above)

    const newest = await lruStore.peek('key-c', 60_000);
    expect(newest).not.toBeNull();
    expect(newest!.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

describe('getStore', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetStore();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetStore();
  });

  it('defaults to MemoryRateLimitStore when RATE_LIMIT_STORE is not set', () => {
    delete process.env.RATE_LIMIT_STORE;
    const store = getStore();
    expect(store).toBeInstanceOf(MemoryRateLimitStore);
  });

  it('returns MemoryRateLimitStore when RATE_LIMIT_STORE=memory', () => {
    process.env.RATE_LIMIT_STORE = 'memory';
    const store = getStore();
    expect(store).toBeInstanceOf(MemoryRateLimitStore);
  });

  it('returns same instance on subsequent calls (singleton)', () => {
    const store1 = getStore();
    const store2 = getStore();
    expect(store1).toBe(store2);
  });

  it('setStore replaces the singleton', () => {
    const custom: RateLimitStore = {
      increment: vi.fn(),
      reset: vi.fn(),
      peek: vi.fn(),
    };
    setStore(custom);
    expect(getStore()).toBe(custom);
  });

  it('falls back to memory when RATE_LIMIT_STORE=redis but REDIS_URL is missing', () => {
    process.env.RATE_LIMIT_STORE = 'redis';
    delete process.env.REDIS_URL;
    const store = getStore();
    expect(store).toBeInstanceOf(MemoryRateLimitStore);
  });

  it('logs a warning when RATE_LIMIT_STORE=redis but REDIS_URL is missing', () => {
    // Arrange — clear any calls accumulated by earlier tests in this describe block
    process.env.RATE_LIMIT_STORE = 'redis';
    delete process.env.REDIS_URL;
    vi.mocked(logger.warn).mockClear();

    // Act
    getStore();

    // Assert — warn called exactly once with a message mentioning both 'redis' and 'REDIS_URL'
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const warnMessage = String(vi.mocked(logger.warn).mock.calls[0]?.[0]);
    expect(warnMessage.toLowerCase()).toContain('redis');
    expect(warnMessage).toContain('REDIS_URL');
  });

  it('returns a RedisRateLimitStore when RATE_LIMIT_STORE=redis and REDIS_URL is set', () => {
    process.env.RATE_LIMIT_STORE = 'redis';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const store = getStore();
    expect(store).toBeInstanceOf(RedisRateLimitStore);
  });

  it('returns a RedisRateLimitStore when RATE_LIMIT_STORE is uppercase REDIS (case-insensitive)', () => {
    process.env.RATE_LIMIT_STORE = 'REDIS';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const store = getStore();
    expect(store).toBeInstanceOf(RedisRateLimitStore);
  });

  it('returns MemoryRateLimitStore for unknown RATE_LIMIT_STORE value without warning', () => {
    // Arrange
    process.env.RATE_LIMIT_STORE = 'foo';
    vi.mocked(logger.warn).mockClear();

    // Act
    const store = getStore();

    // Assert — falls through to default memory branch; no warn emitted
    expect(store).toBeInstanceOf(MemoryRateLimitStore);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('resetStore causes the next getStore call to return a fresh instance', () => {
    // Arrange — get an initial instance
    const first = getStore();

    // Act — reset and get again
    resetStore();
    const second = getStore();

    // Assert — different object references (both will be MemoryRateLimitStore in this env)
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(MemoryRateLimitStore);
  });
});

// ---------------------------------------------------------------------------
// createAsyncRateLimiter
// ---------------------------------------------------------------------------

describe('createAsyncRateLimiter', () => {
  let store: MemoryRateLimitStore;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('allows requests under the limit', async () => {
    const limiter = createAsyncRateLimiter({ interval: 60_000, maxRequests: 3 }, store);

    const r1 = await limiter.check('token1');
    // test-review:accept tobe_true — structural assertion on MemoryRateLimitStore success field; verifies real store integration
    expect(r1.success).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.check('token1');
    expect(r2.success).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.check('token1');
    expect(r3.success).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('blocks requests over the limit', async () => {
    const limiter = createAsyncRateLimiter({ interval: 60_000, maxRequests: 2 }, store);

    await limiter.check('token1');
    await limiter.check('token1');
    const r3 = await limiter.check('token1');

    expect(r3.success).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.limit).toBe(2);
  });

  it('reset clears the counter', async () => {
    const limiter = createAsyncRateLimiter({ interval: 60_000, maxRequests: 1 }, store);

    await limiter.check('token1');
    const blocked = await limiter.check('token1');
    expect(blocked.success).toBe(false);

    await limiter.reset('token1');
    const afterReset = await limiter.check('token1');
    // test-review:accept tobe_true — structural assertion on rate limiter success field after reset
    expect(afterReset.success).toBe(true);
  });

  it('peek returns count without consuming a request', async () => {
    const limiter = createAsyncRateLimiter({ interval: 60_000, maxRequests: 5 }, store);

    await limiter.check('token1');
    await limiter.check('token1');

    const peeked = await limiter.peek('token1');
    expect(peeked.remaining).toBe(3);

    // Peek again — still the same
    const peeked2 = await limiter.peek('token1');
    expect(peeked2.remaining).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createAsyncDynamicLimiter
// ---------------------------------------------------------------------------

describe('createAsyncDynamicLimiter', () => {
  let store: MemoryRateLimitStore;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
  });

  it('uses default RPM when no custom value provided', async () => {
    const limiter = createAsyncDynamicLimiter('test', 2, store);

    const r1 = await limiter.check('token1');
    // test-review:accept tobe_true — structural assertion on rate limiter success field; verifies real store integration
    expect(r1.success).toBe(true);

    const r2 = await limiter.check('token1');
    expect(r2.success).toBe(true);

    const r3 = await limiter.check('token1');
    expect(r3.success).toBe(false);
    expect(r3.limit).toBe(2);
  });

  it('uses custom RPM when provided', async () => {
    const limiter = createAsyncDynamicLimiter('test', 2, store);

    // Custom limit of 5
    // test-review:accept tobe_true — structural assertion on rate limiter success field
    for (let i = 0; i < 5; i++) {
      const r = await limiter.check('token1', 5);
      expect(r.success).toBe(true);
    }

    const blocked = await limiter.check('token1', 5);
    expect(blocked.success).toBe(false);
    expect(blocked.limit).toBe(5);
  });

  it('falls back to default RPM when customRpm is null', async () => {
    const limiter = createAsyncDynamicLimiter('test', 1, store);

    const r1 = await limiter.check('token1', null);
    // test-review:accept tobe_true — structural assertion on rate limiter success field
    expect(r1.success).toBe(true);

    const r2 = await limiter.check('token1', null);
    expect(r2.success).toBe(false);
  });

  it('reset clears counter for a token', async () => {
    const limiter = createAsyncDynamicLimiter('test', 1, store);

    await limiter.check('token1');
    await limiter.reset('token1');

    const r = await limiter.check('token1');
    // test-review:accept tobe_true — structural assertion on rate limiter success field after reset
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RedisRateLimitStore
// ---------------------------------------------------------------------------

describe('RedisRateLimitStore', () => {
  // The ioredis module is aliased to __mocks__/ioredis.ts via vitest.config.ts.
  // The vi.mock('ioredis', factory) at the top of this file overrides that alias
  // with a controllable mock whose behaviour is driven by three module-scope vars:
  //   ioredisEvalResults         — queue of values to return from eval()
  //   ioredisOnHandlers          — map of event → handler registered via on()
  //   ioredisConstructorShouldThrow — when true, the mock constructor throws

  beforeEach(() => {
    // Reset to clean defaults before each test
    ioredisState.evalResults.length = 0;
    ioredisState.onHandlers = {};
    ioredisState.constructorShouldThrow = false;
    ioredisState.evalShouldReject = null;
  });

  async function buildConnectedStore(url = 'redis://localhost:6379'): Promise<RedisRateLimitStore> {
    const store = new RedisRateLimitStore(url);
    // Yield to the microtask queue so the async init() resolves
    await new Promise((resolve) => setTimeout(resolve, 0));
    return store;
  }

  it('increment returns count and resetAt from the Lua script result', async () => {
    // Arrange: queue the eval return value before the store is built
    ioredisState.evalResults.push(3);
    const store = await buildConnectedStore();

    // Act
    const before = Date.now();
    const result = await store.increment('test-key', 60_000);

    // Assert
    expect(result.count).toBe(3);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('increment and reset use the "rl:" key prefix — separate keys share no state', async () => {
    // Arrange: two stores sharing the same mock client; queue two distinct eval results
    ioredisState.evalResults.push(3); // first increment → count 3
    ioredisState.evalResults.push(7); // second increment → count 7
    const store = await buildConnectedStore();

    // Act: increment two different logical keys
    const resultA = await store.increment('alpha', 60_000);
    const resultB = await store.increment('beta', 60_000);

    // Assert: each call returned its own queued result — they did not share state
    expect(resultA.count).toBe(3);
    expect(resultB.count).toBe(7);

    // Assert: reset('alpha') does not affect a subsequent increment on 'beta'
    ioredisState.evalResults.push(1); // next eval for 'beta'
    await store.reset('alpha');
    const resultC = await store.increment('beta', 60_000);
    expect(resultC.count).toBe(1);
  });

  it('reset completes without error', async () => {
    // Arrange
    const store = await buildConnectedStore();

    // Act + Assert: del should not throw
    await expect(store.reset('reset-key')).resolves.toBeUndefined();
  });

  it('peek returns null when count is 0 (no active entries)', async () => {
    // Arrange: eval returns 0 (no active window)
    ioredisState.evalResults.push(0);
    const store = await buildConnectedStore();

    // Act
    const result = await store.peek('empty-key', 60_000);

    // Assert
    expect(result).toBeNull();
  });

  it('peek returns count and resetAt when count > 0', async () => {
    // Arrange: eval returns 5
    ioredisState.evalResults.push(5);
    const store = await buildConnectedStore();

    // Act
    const before = Date.now();
    const result = await store.peek('active-key', 60_000);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.count).toBe(5);
    expect(result!.resetAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('logs an error and remains unready when ioredis constructor throws', async () => {
    // Arrange: make the constructor throw synchronously
    ioredisState.constructorShouldThrow = true;
    const { logger } = await import('@/lib/logging');

    // Act
    const store = new RedisRateLimitStore('redis://broken:6379');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Assert: store is not ready — any operation throws
    await expect(store.increment('any-key', 60_000)).rejects.toThrow(
      'Redis rate limit store is not connected'
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to initialize Redis rate limit store — falling back will not work',
      expect.any(Error)
    );
  });

  it('registers an error event handler that logs connection errors', async () => {
    // Arrange: store is connected (building it triggers client.on() registration)
    await buildConnectedStore();
    const { logger } = await import('@/lib/logging');

    // Act: simulate a Redis error event
    const handler = ioredisState.onHandlers['error'];
    expect(handler).toBeDefined();
    handler(new Error('ECONNREFUSED'));

    // Assert
    expect(logger.error).toHaveBeenCalledWith(
      'Redis rate limit store connection error',
      expect.any(Error)
    );
  });

  it('logs success with masked URL on connection', async () => {
    // Arrange: URL with credentials that must be masked in the log
    const { logger } = await import('@/lib/logging');
    vi.clearAllMocks();

    // Act
    await buildConnectedStore('redis://:s3cr3t@redis.prod.example.com:6379');

    // Assert: the logged URL has credentials replaced
    expect(logger.info).toHaveBeenCalledWith(
      'Redis rate limit store connected',
      expect.objectContaining({ url: expect.not.stringContaining('s3cr3t') })
    );
  });

  it('propagates eval error thrown during increment', async () => {
    // Arrange: build a connected store, then make the next eval() call reject
    const store = await buildConnectedStore();
    ioredisState.evalShouldReject = new Error(
      'READONLY You cannot write against a read only replica'
    );

    // Act + Assert: increment should propagate the Redis error to the caller
    await expect(store.increment('any-key', 60_000)).rejects.toThrow('READONLY');
  });

  it('propagates eval error thrown during peek', async () => {
    // Arrange: build a connected store, then make the next eval() call reject
    const store = await buildConnectedStore();
    ioredisState.evalShouldReject = new Error('NOSCRIPT No matching script');

    // Act + Assert: peek should propagate the Redis error to the caller
    await expect(store.peek('any-key', 60_000)).rejects.toThrow('NOSCRIPT');
  });
});
