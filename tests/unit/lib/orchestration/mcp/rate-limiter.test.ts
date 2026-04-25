import { describe, it, expect, beforeEach } from 'vitest';

// Rate limiter uses the real createRateLimiter — no mock needed.
// We test only the McpRateLimiter wrapper behaviour.

import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';

describe('McpRateLimiter', () => {
  let limiter: McpRateLimiter;

  beforeEach(() => {
    limiter = new McpRateLimiter();
  });

  describe('check', () => {
    it('returns a RateLimitResult with success=true on first call', () => {
      const result = limiter.check('key-1', 10);
      // test-review:accept tobe_true — structural assertion on RateLimitResult.success boolean field
      expect(result.success).toBe(true);
    });

    it('result contains limit equal to maxRequests', () => {
      const result = limiter.check('key-1', 5);
      expect(result.limit).toBe(5);
    });

    it('decrements remaining on each successful call', () => {
      const first = limiter.check('key-1', 5);
      const second = limiter.check('key-1', 5);
      expect(second.remaining).toBeLessThan(first.remaining);
    });

    it('returns success=false once maxRequests is exhausted', () => {
      const maxRequests = 3;
      for (let i = 0; i < maxRequests; i++) {
        limiter.check('key-exhaust', maxRequests);
      }
      const result = limiter.check('key-exhaust', maxRequests);
      expect(result.success).toBe(false);
    });

    it('tracks each apiKeyId independently', () => {
      const maxRequests = 2;
      // Exhaust key-A
      limiter.check('key-A', maxRequests);
      limiter.check('key-A', maxRequests);

      // key-B should still succeed
      const result = limiter.check('key-B', maxRequests);
      // test-review:accept tobe_true — structural assertion on RateLimitResult.success boolean field
      expect(result.success).toBe(true);
    });

    it('replaces the limiter when maxRequests changes for the same key', () => {
      // First call with maxRequests=2
      limiter.check('key-change', 2);
      limiter.check('key-change', 2); // 2nd call — limiter at capacity

      // Now call with a higher maxRequests — should create a fresh limiter
      const result = limiter.check('key-change', 10);
      // test-review:accept tobe_true — structural assertion on RateLimitResult.success boolean field
      expect(result.success).toBe(true);
    });

    it('result has a reset field (unix timestamp in seconds)', () => {
      const result = limiter.check('key-1', 10);
      const nowSeconds = Math.floor(Date.now() / 1000);
      expect(result.reset).toBeGreaterThanOrEqual(nowSeconds);
    });

    it('remaining is 0 when rate limit is exceeded', () => {
      const maxRequests = 1;
      limiter.check('key-r', maxRequests); // consumes the only slot
      const result = limiter.check('key-r', maxRequests); // rejected
      expect(result.remaining).toBe(0);
    });

    it('allows maxRequests-1 remaining after first successful call', () => {
      const maxRequests = 5;
      const result = limiter.check('key-1', maxRequests);
      expect(result.remaining).toBe(maxRequests - 1);
    });
  });

  describe('clear', () => {
    it('resets all limiters so all keys can make requests again', () => {
      const maxRequests = 1;
      limiter.check('key-1', maxRequests); // consumes quota
      expect(limiter.check('key-1', maxRequests).success).toBe(false);

      limiter.clear();

      expect(limiter.check('key-1', maxRequests).success).toBe(true);
    });

    it('works when called on an empty limiter', () => {
      expect(() => limiter.clear()).not.toThrow();
    });

    it('clears multiple keys at once', () => {
      const maxRequests = 1;
      limiter.check('key-A', maxRequests);
      limiter.check('key-B', maxRequests);

      limiter.clear();

      expect(limiter.check('key-A', maxRequests).success).toBe(true);
      expect(limiter.check('key-B', maxRequests).success).toBe(true);
    });
  });
});
