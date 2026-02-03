/**
 * Unit Tests for Verification Email Rate Limiter
 *
 * Tests for verificationEmailLimiter from lib/security/rate-limit.ts
 *
 * Coverage:
 * - Rate limit configuration (3 requests per 15 minutes)
 * - Sliding window algorithm behavior
 * - Request counting and remaining calculation
 * - Reset time calculation
 * - Token isolation (different IPs tracked separately)
 * - Rate limit exceeded scenarios
 * - Reset functionality
 * - Peek functionality (non-consuming check)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verificationEmailLimiter } from '@/lib/security/rate-limit';

describe('lib/security/rate-limit - verificationEmailLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear rate limiter state between tests
    verificationEmailLimiter.reset('test-ip-1');
    verificationEmailLimiter.reset('test-ip-2');
    verificationEmailLimiter.reset('test-ip-3');
  });

  describe('configuration', () => {
    it('should allow 3 requests per IP', () => {
      // Arrange
      const ip = 'test-ip-config';

      // Act: Make 3 requests
      const result1 = verificationEmailLimiter.check(ip);
      const result2 = verificationEmailLimiter.check(ip);
      const result3 = verificationEmailLimiter.check(ip);

      // Assert: All 3 should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);
      expect(result3.limit).toBe(3);
    });

    it('should block 4th request from same IP', () => {
      // Arrange
      const ip = 'test-ip-block';

      // Act: Make 3 allowed requests + 1 blocked
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      const result4 = verificationEmailLimiter.check(ip);

      // Assert: 4th request should be blocked
      expect(result4.success).toBe(false);
      expect(result4.remaining).toBe(0);
    });

    it('should have 15 minute window (900000ms)', () => {
      // Arrange
      const ip = 'test-ip-window';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert: Reset time should be ~15 minutes from now
      const now = Math.floor(Date.now() / 1000);
      const fifteenMinutesFromNow = now + 15 * 60;

      // Allow 5 second variance for test execution time
      expect(result.reset).toBeGreaterThanOrEqual(fifteenMinutesFromNow - 5);
      expect(result.reset).toBeLessThanOrEqual(fifteenMinutesFromNow + 5);
    });
  });

  describe('request counting', () => {
    it('should start with 2 remaining after first request', () => {
      // Arrange
      const ip = 'test-ip-count-1';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.success).toBe(true);
      expect(result.limit).toBe(3);
      expect(result.remaining).toBe(2);
    });

    it('should decrement remaining count with each request', () => {
      // Arrange
      const ip = 'test-ip-count-2';

      // Act
      const result1 = verificationEmailLimiter.check(ip);
      const result2 = verificationEmailLimiter.check(ip);
      const result3 = verificationEmailLimiter.check(ip);

      // Assert
      expect(result1.remaining).toBe(2);
      expect(result2.remaining).toBe(1);
      expect(result3.remaining).toBe(0);
    });

    it('should keep remaining at 0 after limit exceeded', () => {
      // Arrange
      const ip = 'test-ip-count-3';

      // Act: Exhaust limit
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      const result4 = verificationEmailLimiter.check(ip);
      const result5 = verificationEmailLimiter.check(ip);

      // Assert: Should stay at 0
      expect(result4.remaining).toBe(0);
      expect(result5.remaining).toBe(0);
    });

    it('should include limit in response', () => {
      // Arrange
      const ip = 'test-ip-limit';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.limit).toBe(3);
    });
  });

  describe('token isolation', () => {
    it('should track different IPs separately', () => {
      // Arrange
      const ip1 = 'test-ip-isolation-1';
      const ip2 = 'test-ip-isolation-2';

      // Act: Exhaust limit for ip1
      verificationEmailLimiter.check(ip1);
      verificationEmailLimiter.check(ip1);
      verificationEmailLimiter.check(ip1);
      const result1 = verificationEmailLimiter.check(ip1);

      // ip2 should still be allowed
      const result2 = verificationEmailLimiter.check(ip2);

      // Assert
      expect(result1.success).toBe(false); // ip1 blocked
      expect(result2.success).toBe(true); // ip2 allowed
      expect(result2.remaining).toBe(2);
    });

    it('should maintain separate counts for each IP', () => {
      // Arrange
      const ip1 = 'test-ip-separate-1';
      const ip2 = 'test-ip-separate-2';

      // Act: Make 2 requests from ip1, 1 from ip2
      verificationEmailLimiter.check(ip1);
      const result1 = verificationEmailLimiter.check(ip1);
      const result2 = verificationEmailLimiter.check(ip2);

      // Assert
      expect(result1.remaining).toBe(1); // ip1 has 1 remaining
      expect(result2.remaining).toBe(2); // ip2 has 2 remaining
    });

    it('should handle many different IPs', () => {
      // Arrange: Create 10 different IPs
      const ips = Array.from({ length: 10 }, (_, i) => `test-ip-many-${i}`);

      // Act: Make request from each IP
      const results = ips.map((ip) => verificationEmailLimiter.check(ip));

      // Assert: All should succeed independently
      results.forEach((result) => {
        expect(result.success).toBe(true);
        expect(result.remaining).toBe(2);
      });
    });
  });

  describe('success flag', () => {
    it('should return success=true when under limit', () => {
      // Arrange
      const ip = 'test-ip-success';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should return success=false when limit exceeded', () => {
      // Arrange
      const ip = 'test-ip-fail';

      // Act: Exhaust limit
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('reset time', () => {
    it('should provide Unix timestamp for reset', () => {
      // Arrange
      const ip = 'test-ip-reset-time';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert: Reset should be Unix timestamp (seconds)
      expect(result.reset).toBeGreaterThan(Date.now() / 1000);
      expect(result.reset).toBeLessThan(Date.now() / 1000 + 20 * 60); // Within 20 minutes
    });

    it('should have consistent reset time for same window', () => {
      // Arrange
      const ip = 'test-ip-reset-consistent';

      // Act: Make multiple requests in quick succession
      const result1 = verificationEmailLimiter.check(ip);
      const result2 = verificationEmailLimiter.check(ip);

      // Assert: Reset times should be very close (within 1 second)
      expect(Math.abs(result1.reset - result2.reset)).toBeLessThanOrEqual(1);
    });
  });

  describe('reset functionality', () => {
    it('should clear rate limit for specific IP', () => {
      // Arrange: Exhaust limit
      const ip = 'test-ip-reset-func';
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      const blockedResult = verificationEmailLimiter.check(ip);
      expect(blockedResult.success).toBe(false);

      // Act: Reset the IP
      verificationEmailLimiter.reset(ip);
      const afterResetResult = verificationEmailLimiter.check(ip);

      // Assert: Should be allowed again
      expect(afterResetResult.success).toBe(true);
      expect(afterResetResult.remaining).toBe(2);
    });

    it('should only reset specific IP, not others', () => {
      // Arrange: Exhaust limit for two IPs
      const ip1 = 'test-ip-reset-specific-1';
      const ip2 = 'test-ip-reset-specific-2';

      verificationEmailLimiter.check(ip1);
      verificationEmailLimiter.check(ip1);
      verificationEmailLimiter.check(ip1);

      verificationEmailLimiter.check(ip2);
      verificationEmailLimiter.check(ip2);
      verificationEmailLimiter.check(ip2);

      // Act: Reset only ip1
      verificationEmailLimiter.reset(ip1);

      const result1 = verificationEmailLimiter.check(ip1);
      const result2 = verificationEmailLimiter.check(ip2);

      // Assert
      expect(result1.success).toBe(true); // ip1 reset, allowed
      expect(result2.success).toBe(false); // ip2 still blocked
    });

    it('should be safe to reset non-existent IP', () => {
      // Arrange
      const ip = 'test-ip-never-used';

      // Act & Assert: Should not throw
      expect(() => verificationEmailLimiter.reset(ip)).not.toThrow();
    });
  });

  describe('peek functionality', () => {
    it('should return current state without consuming a request', () => {
      // Arrange
      const ip = 'test-ip-peek';

      // Act: Peek first
      const peekResult = verificationEmailLimiter.peek(ip);
      const checkResult = verificationEmailLimiter.check(ip);

      // Assert: Peek should show 3 remaining, check should consume one
      expect(peekResult.success).toBe(true);
      expect(peekResult.remaining).toBe(3);
      expect(checkResult.success).toBe(true);
      expect(checkResult.remaining).toBe(2);
    });

    it('should peek at blocked state without consuming', () => {
      // Arrange: Exhaust limit
      const ip = 'test-ip-peek-blocked';
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);

      // Act: Peek multiple times
      const peek1 = verificationEmailLimiter.peek(ip);
      const peek2 = verificationEmailLimiter.peek(ip);

      // Assert: Both peeks should show same blocked state
      expect(peek1.success).toBe(false);
      expect(peek1.remaining).toBe(0);
      expect(peek2.success).toBe(false);
      expect(peek2.remaining).toBe(0);
    });

    it('should allow checking status before deciding to send request', () => {
      // Arrange
      const ip = 'test-ip-peek-before-check';
      verificationEmailLimiter.check(ip);
      verificationEmailLimiter.check(ip);

      // Act: Peek to see remaining
      const peekResult = verificationEmailLimiter.peek(ip);

      // Assert: Should show 1 remaining
      expect(peekResult.success).toBe(true);
      expect(peekResult.remaining).toBe(1);

      // Act: Now consume the last request
      const checkResult = verificationEmailLimiter.check(ip);
      expect(checkResult.success).toBe(true);
      expect(checkResult.remaining).toBe(0);
    });

    it('should have same limit and reset values as check', () => {
      // Arrange
      const ip = 'test-ip-peek-values';

      // Act
      const peekResult = verificationEmailLimiter.peek(ip);
      const checkResult = verificationEmailLimiter.check(ip);

      // Assert: limit and reset should match
      expect(peekResult.limit).toBe(checkResult.limit);
      expect(Math.abs(peekResult.reset - checkResult.reset)).toBeLessThanOrEqual(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string IP', () => {
      // Arrange
      const ip = '';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert: Should work (treats empty string as valid token)
      expect(result.success).toBe(true);
      expect(result.limit).toBe(3);
    });

    it('should handle special characters in IP', () => {
      // Arrange
      const ip = '192.168.1.1:8080';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.success).toBe(true);
      expect(result.limit).toBe(3);
    });

    it('should handle very long IP string', () => {
      // Arrange
      const ip = 'x'.repeat(1000);

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert
      expect(result.success).toBe(true);
      expect(result.limit).toBe(3);
    });

    it('should handle rapid successive calls', () => {
      // Arrange
      const ip = 'test-ip-rapid';

      // Act: Make all 3 requests rapidly
      const results = [
        verificationEmailLimiter.check(ip),
        verificationEmailLimiter.check(ip),
        verificationEmailLimiter.check(ip),
      ];

      // Assert: All should succeed with correct remaining counts
      expect(results[0].remaining).toBe(2);
      expect(results[1].remaining).toBe(1);
      expect(results[2].remaining).toBe(0);
    });
  });

  describe('integration with API endpoint', () => {
    it('should match expected behavior for send-verification-email endpoint', () => {
      // Arrange: Simulate user requesting verification emails
      const userIP = '203.0.113.42';

      // Act: User makes 3 requests (allowed limit)
      const request1 = verificationEmailLimiter.check(userIP);
      const request2 = verificationEmailLimiter.check(userIP);
      const request3 = verificationEmailLimiter.check(userIP);

      // Assert: All 3 should succeed
      expect(request1.success).toBe(true);
      expect(request2.success).toBe(true);
      expect(request3.success).toBe(true);

      // Act: User tries to make 4th request (should be blocked)
      const request4 = verificationEmailLimiter.check(userIP);

      // Assert: 4th request blocked
      expect(request4.success).toBe(false);
      expect(request4.remaining).toBe(0);

      // This would trigger 429 Too Many Requests in the endpoint
    });

    it('should provide rate limit headers data', () => {
      // Arrange
      const ip = 'test-ip-headers';

      // Act
      const result = verificationEmailLimiter.check(ip);

      // Assert: Result contains all data needed for rate limit headers
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('reset');
      expect(result).toHaveProperty('success');

      // These would map to:
      // X-RateLimit-Limit: result.limit
      // X-RateLimit-Remaining: result.remaining
      // X-RateLimit-Reset: result.reset
    });
  });

  describe('comparison with other limiters', () => {
    it('should have same limit as passwordResetLimiter (3 requests per 15 minutes)', () => {
      // This is a sanity check that verificationEmailLimiter uses same config as passwordResetLimiter

      // Arrange
      const ip = 'test-ip-comparison';

      // Act: Check limit
      const result = verificationEmailLimiter.check(ip);

      // Assert: Should be 3 requests
      expect(result.limit).toBe(3);
    });
  });

  describe('real-world scenarios', () => {
    it('should prevent email bombing attack', () => {
      // Arrange: Attacker tries to spam verification emails
      const attackerIP = '198.51.100.42';

      // Act: Attacker makes rapid requests
      const attempt1 = verificationEmailLimiter.check(attackerIP);
      const attempt2 = verificationEmailLimiter.check(attackerIP);
      const attempt3 = verificationEmailLimiter.check(attackerIP);
      const attempt4 = verificationEmailLimiter.check(attackerIP);
      const attempt5 = verificationEmailLimiter.check(attackerIP);

      // Assert: First 3 succeed, rest blocked
      expect(attempt1.success).toBe(true);
      expect(attempt2.success).toBe(true);
      expect(attempt3.success).toBe(true);
      expect(attempt4.success).toBe(false);
      expect(attempt5.success).toBe(false);
    });

    it('should allow legitimate user retries', () => {
      // Arrange: User didn't receive first email, wants to retry
      const userIP = '203.0.113.100';

      // Act: User requests email 3 times over 15 minutes
      const request1 = verificationEmailLimiter.check(userIP); // Initial request
      const request2 = verificationEmailLimiter.check(userIP); // Retry 1
      const request3 = verificationEmailLimiter.check(userIP); // Retry 2

      // Assert: All 3 retries allowed
      expect(request1.success).toBe(true);
      expect(request2.success).toBe(true);
      expect(request3.success).toBe(true);
    });

    it('should track admin and regular user separately', () => {
      // Arrange
      const adminIP = '10.0.0.1';
      const userIP = '203.0.113.50';

      // Act: Admin exhausts limit
      verificationEmailLimiter.check(adminIP);
      verificationEmailLimiter.check(adminIP);
      verificationEmailLimiter.check(adminIP);
      const adminBlocked = verificationEmailLimiter.check(adminIP);

      // User should still be able to request
      const userAllowed = verificationEmailLimiter.check(userIP);

      // Assert
      expect(adminBlocked.success).toBe(false);
      expect(userAllowed.success).toBe(true);
    });
  });
});
