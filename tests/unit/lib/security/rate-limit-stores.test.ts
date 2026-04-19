/**
 * Tests for Rate Limit Store Abstraction
 *
 * Covers:
 * - MemoryRateLimitStore: increment, reset, peek, sliding window
 * - Store factory: default to memory, fallback when Redis URL missing
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

import { MemoryRateLimitStore } from '@/lib/security/rate-limit-stores/memory';
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
