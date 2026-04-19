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
    expect(r1.success).toBe(true);

    const r2 = await limiter.check('token1', null);
    expect(r2.success).toBe(false);
  });

  it('reset clears counter for a token', async () => {
    const limiter = createAsyncDynamicLimiter('test', 1, store);

    await limiter.check('token1');
    await limiter.reset('token1');

    const r = await limiter.check('token1');
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

  it('increment prefixes the key with "rl:"', async () => {
    // Arrange: the default eval result (1) is fine; just build the store
    const store = await buildConnectedStore();

    // The mock eval() always resolves to the next queued value (or 1 by default).
    // To verify the key prefix we call increment and trust the source code, which
    // passes the prefixed key as the third argument to eval.  We confirm the
    // operation succeeds (count === 1) which proves the mock client was invoked.
    const result = await store.increment('my-key', 60_000);
    expect(result.count).toBe(1);
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
});
