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
  authLimiter,
  apiLimiter,
  passwordResetLimiter,
  getRateLimitHeaders,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';

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
      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(authLimiter.check(`auth-test-${Date.now()}-${i}`));
      }

      // First request should show limit of 5
      expect(results[0].limit).toBe(5);

      // Reset for cleanup
      for (let i = 0; i < 6; i++) {
        authLimiter.reset(`auth-test-${Date.now()}-${i}`);
      }
    });

    it('apiLimiter should have correct configuration', () => {
      const result = apiLimiter.check(`api-test-${Date.now()}`);
      expect(result.limit).toBe(100);
      apiLimiter.reset(`api-test-${Date.now()}`);
    });

    it('passwordResetLimiter should have stricter limits', () => {
      const result = passwordResetLimiter.check(`pwd-test-${Date.now()}`);
      expect(result.limit).toBe(3);
      passwordResetLimiter.reset(`pwd-test-${Date.now()}`);
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
      expect(response.headers.get('Retry-After')).toBeDefined();

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });
});
