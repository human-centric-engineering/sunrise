/**
 * Rate Limiter Unit Tests
 *
 * Tests for the LRU cache-based sliding window rate limiter.
 *
 * @see lib/security/rate-limit.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createRateLimiter,
  createDynamicLimiter,
  createAsyncRateLimiter,
  createAsyncDynamicLimiter,
  authLimiter,
  apiLimiter,
  passwordResetLimiter,
  getRateLimitHeaders,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';
import { MemoryRateLimitStore } from '@/lib/security/rate-limit-stores/memory';

describe('Rate Limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createRateLimiter', () => {
    it('should allow requests under the limit', () => {
      const limiter = createRateLimiter({
        interval: 60000, // 1 minute
        maxRequests: 5,
      });

      // First 5 requests should succeed
      // test-review:accept tobe_true — structural assertion on rate limiter success field; verifies sliding-window allow/block contract
      for (let i = 0; i < 5; i++) {
        const result = limiter.check('test-ip');
        expect(result.success).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }
    });

    it('should block requests over the limit', () => {
      const limiter = createRateLimiter({
        interval: 60000,
        maxRequests: 3,
      });

      // Fill up the limit
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      for (let i = 0; i < 3; i++) {
        const result = limiter.check('block-ip');
        expect(result.success).toBe(true);
      }

      // Next request should be blocked
      const blockedResult = limiter.check('block-ip');
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.remaining).toBe(0);
    });

    it('should track different tokens (IPs) separately', () => {
      const limiter = createRateLimiter({
        interval: 60000,
        maxRequests: 2,
      });

      // Fill limit for IP1
      limiter.check('ip-1');
      limiter.check('ip-1');
      expect(limiter.check('ip-1').success).toBe(false);

      // IP2 should still have full quota
      const ip2Result = limiter.check('ip-2');
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(ip2Result.success).toBe(true);
      expect(ip2Result.remaining).toBe(1);
    });

    it('should reset after interval window expires', () => {
      const limiter = createRateLimiter({
        interval: 60000, // 1 minute
        maxRequests: 2,
      });

      // Fill the limit
      limiter.check('time-ip');
      limiter.check('time-ip');
      expect(limiter.check('time-ip').success).toBe(false);

      // Advance time past the interval
      vi.advanceTimersByTime(61000);

      // Should be able to make requests again
      const result = limiter.check('time-ip');
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
    });

    it('should support sliding window (partial reset)', () => {
      const limiter = createRateLimiter({
        interval: 60000, // 1 minute
        maxRequests: 3,
      });

      // Make 2 requests at t=0
      limiter.check('slide-ip');
      limiter.check('slide-ip');

      // Advance 30 seconds
      vi.advanceTimersByTime(30000);

      // Make 1 more request at t=30s
      limiter.check('slide-ip');

      // Should be blocked now (3 requests in last 60s)
      expect(limiter.check('slide-ip').success).toBe(false);

      // Advance another 31 seconds (total 61s from first request)
      vi.advanceTimersByTime(31000);

      // First 2 requests should have expired, only 1 remains
      // Should be able to make 2 more requests
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(limiter.check('slide-ip').success).toBe(true);
      expect(limiter.check('slide-ip').success).toBe(true);
      expect(limiter.check('slide-ip').success).toBe(false);
    });

    it('should provide correct limit and reset values', () => {
      const limiter = createRateLimiter({
        interval: 60000,
        maxRequests: 10,
      });

      const result = limiter.check('info-ip');
      expect(result.limit).toBe(10);
      expect(result.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should support manual reset', () => {
      const limiter = createRateLimiter({
        interval: 60000,
        maxRequests: 2,
      });

      // Fill the limit
      limiter.check('reset-ip');
      limiter.check('reset-ip');
      expect(limiter.check('reset-ip').success).toBe(false);

      // Manual reset
      limiter.reset('reset-ip');

      // Should have full quota again
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(limiter.check('reset-ip').success).toBe(true);
    });

    it('should support peek without consuming request', () => {
      const limiter = createRateLimiter({
        interval: 60000,
        maxRequests: 3,
      });

      // Make 2 requests
      limiter.check('peek-ip');
      limiter.check('peek-ip');

      // Peek should show 1 remaining without consuming
      const peekResult = limiter.peek('peek-ip');
      expect(peekResult.remaining).toBe(1);
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(peekResult.success).toBe(true);

      // Peek again - still 1 remaining
      const peekResult2 = limiter.peek('peek-ip');
      expect(peekResult2.remaining).toBe(1);

      // Check should consume and show 0 remaining
      const checkResult = limiter.check('peek-ip');
      expect(checkResult.remaining).toBe(0);
    });
  });

  describe('Pre-configured limiters', () => {
    it('authLimiter should have correct configuration', () => {
      // Auth limiter: 5 requests per minute
      // Arrange: capture tokens upfront so check and reset use the same token
      const tokens = Array.from({ length: 6 }, (_, i) => `auth-test-${Date.now()}-${i}`);
      const results = tokens.map((token) => authLimiter.check(token));

      // Assert: First request should show limit of 5
      expect(results[0].limit).toBe(5);

      // Cleanup: reuse the same captured tokens
      tokens.forEach((token) => authLimiter.reset(token));
    });

    it('apiLimiter should have correct configuration', () => {
      // Arrange: capture token so check and reset reference the same key
      const token = `api-test-${Date.now()}`;

      // Act
      const result = apiLimiter.check(token);

      // Assert
      expect(result.limit).toBe(100);

      // Cleanup
      apiLimiter.reset(token);
    });

    it('passwordResetLimiter should have stricter limits', () => {
      // Arrange: capture token so check and reset reference the same key
      const token = `pwd-test-${Date.now()}`;

      // Act
      const result = passwordResetLimiter.check(token);

      // Assert
      expect(result.limit).toBe(3);

      // Cleanup
      passwordResetLimiter.reset(token);
    });
  });

  describe('createDynamicLimiter', () => {
    it('should use the default RPM when no custom limit is provided', () => {
      const limiter = createDynamicLimiter('test', 5);
      const token = `dyn-default-${Date.now()}`;

      for (let i = 0; i < 5; i++) {
        expect(limiter.check(token).success).toBe(true);
      }
      expect(limiter.check(token).success).toBe(false);
    });

    it('should use custom RPM when provided', () => {
      const limiter = createDynamicLimiter('test', 5);
      const token = `dyn-custom-${Date.now()}`;

      // Custom limit of 2
      expect(limiter.check(token, 2).success).toBe(true);
      expect(limiter.check(token, 2).success).toBe(true);
      expect(limiter.check(token, 2).success).toBe(false);
    });

    it('should fall back to default when customRpm is null', () => {
      const limiter = createDynamicLimiter('test', 3);
      const token = `dyn-null-${Date.now()}`;

      for (let i = 0; i < 3; i++) {
        expect(limiter.check(token, null).success).toBe(true);
      }
      expect(limiter.check(token, null).success).toBe(false);
    });

    it('should track different tokens independently', () => {
      const limiter = createDynamicLimiter('test', 2);
      const tokenA = `dyn-a-${Date.now()}`;
      const tokenB = `dyn-b-${Date.now()}`;

      expect(limiter.check(tokenA).success).toBe(true);
      expect(limiter.check(tokenA).success).toBe(true);
      expect(limiter.check(tokenA).success).toBe(false);

      // Token B should be independent
      expect(limiter.check(tokenB).success).toBe(true);
    });

    it('should reset a token', () => {
      const limiter = createDynamicLimiter('test', 1);
      const token = `dyn-reset-${Date.now()}`;

      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(limiter.check(token).success).toBe(true);
      expect(limiter.check(token).success).toBe(false);

      limiter.reset(token);
      expect(limiter.check(token).success).toBe(true);
    });

    it('should return correct remaining count with custom RPM', () => {
      const limiter = createDynamicLimiter('test', 10);
      const token = `dyn-remaining-${Date.now()}`;

      const result = limiter.check(token, 5);
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4);
    });
  });

  describe('createAsyncRateLimiter', () => {
    it('should allow requests below the limit', async () => {
      // Arrange: maxRequests=3, async uses count-after-add with <= comparison
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 3 }, store);
      const token = 'async-allow-ip';

      // Act: both requests succeed (count→1, count→2; both <= 3)
      const first = await limiter.check(token);
      const second = await limiter.check(token);

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    });

    it('should block requests at the limit boundary (maxRequests = 3)', async () => {
      // Arrange: increment() returns count-after-add; success = count <= maxRequests
      // So 3 requests succeed (counts 1,2,3 — all <=3), 4th is blocked (4<=3 false)
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 3 }, store);
      const token = 'async-block-ip';

      // Act
      await limiter.check(token); // count → 1 (success)
      await limiter.check(token); // count → 2 (success)
      const thirdResult = await limiter.check(token); // count → 3 (success: 3 <= 3)
      const blockedResult = await limiter.check(token); // count → 4 (blocked: 4 <= 3 is false)

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(thirdResult.success).toBe(true);
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.remaining).toBe(0);
    });

    it('should reset the counter for a token', async () => {
      // Arrange: maxRequests=2, increment() returns count-after-add, success = count <= maxRequests
      // Both requests succeed (counts 1,2 — both <=2), 3rd is blocked (3<=2 false)
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 2 }, store);
      const token = 'async-reset-ip';

      // Act: exhaust limit, then reset
      await limiter.check(token); // count → 1 (success)
      await limiter.check(token); // count → 2 (success)
      const exhausted = await limiter.check(token); // count → 3 (blocked)
      expect(exhausted.success).toBe(false);

      await limiter.reset(token);
      const result = await limiter.check(token); // count → 1 after reset (success)

      // Assert: request allowed after reset
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
    });

    it('should peek at count without consuming a request', async () => {
      // Arrange
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 5 }, store);
      const token = 'async-peek-ip';

      // Act: peek before any checks
      const peekBefore = await limiter.peek(token);

      // Assert (Finding 7): null entry → remaining equals maxRequests
      expect(peekBefore.remaining).toBe(5);
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(peekBefore.success).toBe(true);

      // Act: consume 2 requests, then peek again
      await limiter.check(token);
      await limiter.check(token);
      const peekAfter = await limiter.peek(token);

      // Assert: remaining reflects consumed requests without adding another
      expect(peekAfter.remaining).toBe(3);
    });

    it('should use an injected store', async () => {
      // Arrange: verify the store-injection branch by passing an explicit store
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 2 }, store);
      const token = 'async-store-ip';

      // Act
      const result = await limiter.check(token);

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
      expect(result.limit).toBe(2);
    });

    it('should block at the rate-limit boundary with maxRequests = 3 (Finding 9)', async () => {
      // Arrange: verify boundary for both sync and async limiters.
      // Sync uses count-before-add (< maxRequests): allows exactly maxRequests calls.
      // Async uses count-after-add (<= maxRequests): also allows exactly maxRequests calls.
      // Both paths allow the same number of requests — the operators differ to compensate
      // for increment() returning count-after-add vs count-before-add.
      const store = new MemoryRateLimitStore();
      const asyncLimiter = createAsyncRateLimiter({ interval: 60000, maxRequests: 3 }, store);
      const syncLimiter = createRateLimiter({ interval: 60000, maxRequests: 3 });
      const asyncToken = 'boundary-async';
      const syncToken = 'boundary-sync';

      // Sync: 3 succeed, 4th is blocked (count_before reaches 3)
      // test-review:accept tobe_true — structural assertion on rate limiter success field; boundary test documents sync vs async parity
      expect(syncLimiter.check(syncToken).success).toBe(true); // 1st: count_before=0
      expect(syncLimiter.check(syncToken).success).toBe(true); // 2nd: count_before=1
      expect(syncLimiter.check(syncToken).success).toBe(true); // 3rd: count_before=2
      expect(syncLimiter.check(syncToken).success).toBe(false); // 4th: count_before=3 → blocked

      // Async: 3 succeed, 4th is blocked (count_after 4 > maxRequests 3)
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect((await asyncLimiter.check(asyncToken)).success).toBe(true); // count→1 (1<=3)
      expect((await asyncLimiter.check(asyncToken)).success).toBe(true); // count→2 (2<=3)
      expect((await asyncLimiter.check(asyncToken)).success).toBe(true); // count→3 (3<=3)
      expect((await asyncLimiter.check(asyncToken)).success).toBe(false); // count→4 (4<=3 false)
    });
  });

  describe('createAsyncDynamicLimiter', () => {
    it('should allow requests under the default RPM', async () => {
      // Arrange
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncDynamicLimiter('test', 5, store);
      const token = 'async-dyn-default-ip';

      // Act
      const result = await limiter.check(token);

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
      expect(result.limit).toBe(5);
    });

    it('should use customRpm when provided (Finding 6 — override branch)', async () => {
      // Arrange
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncDynamicLimiter('test', 10, store);
      const token = 'async-dyn-custom-ip';

      // Act: check with customRpm = 50
      const result = await limiter.check(token, 50);

      // Assert: limit reflects the custom override
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
      expect(result.limit).toBe(50);
    });

    it('should fall back to defaultRpm when customRpm is null (Finding 6 — fallback branch)', async () => {
      // Arrange
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncDynamicLimiter('test', 10, store);
      const token = 'async-dyn-null-ip';

      // Act: check with null customRpm — should use defaultRpm = 10
      const result = await limiter.check(token, null);

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
      expect(result.limit).toBe(10);
    });

    it('should block at the limit boundary with customRpm', async () => {
      // Arrange: increment() returns count-after-add; success = count <= maxRequests
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncDynamicLimiter('test', 10, store);
      const token = 'async-dyn-block-ip';

      // Act: customRpm = 2 → first two succeed (counts 1,2 — both <=2), third blocked (3<=2 false)
      await limiter.check(token, 2); // count → 1 (success)
      const secondResult = await limiter.check(token, 2); // count → 2 (success: 2 <= 2)
      const blockedResult = await limiter.check(token, 2); // count → 3 (blocked: 3 <= 2 is false)

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(secondResult.success).toBe(true);
      expect(blockedResult.success).toBe(false);
    });

    it('should reset a token', async () => {
      // Arrange: maxRequests=2, success = count <= maxRequests
      // Both requests succeed (counts 1,2), 3rd is blocked (3<=2 false)
      const store = new MemoryRateLimitStore();
      const limiter = createAsyncDynamicLimiter('test', 2, store);
      const token = 'async-dyn-reset-ip';

      // Act: exhaust then reset
      await limiter.check(token); // count → 1 (success)
      await limiter.check(token); // count → 2 (success)
      const exhausted = await limiter.check(token); // count → 3 (blocked)
      expect(exhausted.success).toBe(false);

      await limiter.reset(token);
      const result = await limiter.check(token); // count → 1 after reset (success)

      // Assert
      // test-review:accept tobe_true — structural assertion on rate limiter success field
      expect(result.success).toBe(true);
    });
  });

  describe('Response helpers', () => {
    it('getRateLimitHeaders should return correct headers', () => {
      const result = {
        success: true,
        limit: 100,
        remaining: 95,
        reset: 1234567890,
      };

      const headers = getRateLimitHeaders(result);

      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('95');
      expect(headers['X-RateLimit-Reset']).toBe('1234567890');
    });

    it('createRateLimitResponse should create 429 response', async () => {
      const result = {
        success: false,
        limit: 5,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 60,
      };

      const response = createRateLimitResponse(result);

      expect(response.status).toBe(429);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });
});
