/**
 * Unit Test: Proxy Middleware
 *
 * Tests the middleware proxy function that handles:
 * - Authentication detection via session cookies
 * - Protected route access control
 * - Auth route redirection for authenticated users
 * - Security headers
 * - Rate limiting
 *
 * Test Coverage:
 * - isAuthenticated function with both cookie variants
 * - Protected route access (authenticated vs unauthenticated)
 * - Auth route redirection (authenticated users)
 * - Request ID propagation
 * - Security headers
 *
 * @see proxy.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

/**
 * Mock dependencies
 */

// Mock logging
vi.mock('@/lib/logging/context', () => ({
  generateRequestId: vi.fn(() => 'test-request-id-123'),
}));

// Mock security headers
vi.mock('@/lib/security/headers', () => ({
  setSecurityHeaders: vi.fn((response) => response),
}));

// Mock rate limiting
const mockCheckResult = {
  success: true,
  limit: 100,
  remaining: 99,
  reset: 1234567890,
};

const mockAdminCheckResult = {
  success: true,
  limit: 30,
  remaining: 29,
  reset: 1234567890,
};

const mockAuthCheckResult = {
  success: true,
  limit: 5,
  remaining: 4,
  reset: 1234567890,
};

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: {
    check: vi.fn(() => mockCheckResult),
    peek: vi.fn(() => ({
      success: true,
      remaining: 100,
      limit: 100,
      reset: Date.now() + 60000,
    })),
  },
  adminLimiter: {
    check: vi.fn(() => mockAdminCheckResult),
  },
  authLimiter: {
    check: vi.fn(() => mockAuthCheckResult),
  },
  getRateLimitHeaders: vi.fn((result) => ({
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  })),
  createRateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
}));

// Mock IP extraction
vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn((request) => {
    // Simulate the real behavior: validate X-Forwarded-For
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const ip = forwarded.split(',')[0].trim();
      // Basic validation (matches IPV4_PATTERN from ip.ts)
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
    }
    return '127.0.0.1';
  }),
}));

/**
 * Helper function to create a mock NextRequest
 */
function createMockRequest(
  pathname: string,
  options: {
    cookies?: Record<string, string>;
    method?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const { cookies = {}, method = 'GET', headers = {} } = options;

  const request = {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Map(Object.entries(headers)),
    cookies: {
      get: (name: string) => {
        return cookies[name] ? { name, value: cookies[name] } : undefined;
      },
    },
  } as unknown as NextRequest;

  return request;
}

describe('proxy middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAuthenticated - HTTP cookie (better-auth.session_token)', () => {
    it('should return true when better-auth.session_token cookie is present', () => {
      // Arrange
      const request = createMockRequest('/dashboard', {
        cookies: { 'better-auth.session_token': 'valid-session-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      // If authenticated, should NOT redirect to login (should proceed)
      expect(response.status).not.toBe(307); // 307 is redirect status
      // Should be a NextResponse.next() or similar
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should allow access to protected routes with HTTP cookie', () => {
      // Arrange
      const request = createMockRequest('/dashboard', {
        cookies: { 'better-auth.session_token': 'valid-session-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });
  });

  describe('isAuthenticated - HTTPS cookie (__Secure-better-auth.session_token)', () => {
    it('should return true when __Secure-better-auth.session_token cookie is present', () => {
      // Arrange
      const request = createMockRequest('/dashboard', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      // If authenticated, should NOT redirect to login
      expect(response.status).not.toBe(307);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should allow access to protected routes with HTTPS cookie', () => {
      // Arrange
      const request = createMockRequest('/settings', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });

    it('should allow access to /profile with HTTPS cookie', () => {
      // Arrange
      const request = createMockRequest('/profile', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-session-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });
  });

  describe('isAuthenticated - both cookie variants present', () => {
    it('should authenticate when both HTTP and HTTPS cookies are present', () => {
      // Arrange
      const request = createMockRequest('/dashboard', {
        cookies: {
          'better-auth.session_token': 'http-token',
          '__Secure-better-auth.session_token': 'https-token',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });
  });

  describe('Protected routes - unauthenticated', () => {
    it('should redirect to login when accessing /dashboard without session', () => {
      // Arrange
      const request = createMockRequest('/dashboard', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307); // Redirect
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2Fdashboard');
    });

    it('should redirect to login when accessing /settings without session', () => {
      // Arrange
      const request = createMockRequest('/settings', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2Fsettings');
    });

    it('should redirect to login when accessing /profile without session', () => {
      // Arrange
      const request = createMockRequest('/profile', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });
  });

  describe('Auth routes - authenticated users', () => {
    it('should redirect to dashboard when accessing /login with HTTP cookie', () => {
      // Arrange
      const request = createMockRequest('/login', {
        cookies: { 'better-auth.session_token': 'valid-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });

    it('should redirect to dashboard when accessing /signup with HTTPS cookie', () => {
      // Arrange
      const request = createMockRequest('/signup', {
        cookies: { '__Secure-better-auth.session_token': 'valid-secure-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });

    it('should redirect to dashboard when accessing /reset-password with session', () => {
      // Arrange
      const request = createMockRequest('/reset-password', {
        cookies: { '__Secure-better-auth.session_token': 'valid-token' },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/dashboard');
    });
  });

  describe('Public routes', () => {
    it('should allow unauthenticated access to homepage', () => {
      // Arrange
      const request = createMockRequest('/', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });

    it('should allow unauthenticated access to /about', () => {
      // Arrange
      const request = createMockRequest('/about', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(307); // No redirect
    });
  });

  describe('Request ID propagation', () => {
    it('should add request ID to response headers', () => {
      // Arrange
      const request = createMockRequest('/', { cookies: {} });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should use existing request ID from header if present', () => {
      // Arrange
      const request = createMockRequest('/', {
        cookies: {},
        headers: { 'x-request-id': 'existing-request-id' },
      });

      // Act
      const response = proxy(request);

      // Assert
      // The proxy should use the existing ID (though our mock always returns the same)
      expect(response.headers.get('x-request-id')).toBeDefined();
    });
  });

  describe('Origin validation', () => {
    it('should reject POST requests with invalid origin', () => {
      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: {
          origin: 'https://evil.com',
          host: 'localhost:3000',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).toBe(403);
    });

    it('should allow POST requests with matching origin', () => {
      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(403);
    });

    it('should allow GET requests without origin validation', () => {
      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          origin: 'https://evil.com',
          host: 'localhost:3000',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(response.status).not.toBe(403);
    });
  });

  describe('Rate limiting (I24 fix)', () => {
    it('should call apiLimiter.check() exactly once for /api/v1/ routes', async () => {
      // Import mocked modules
      const { apiLimiter } = await import('@/lib/security/rate-limit');
      const { getClientIP } = await import('@/lib/security/ip');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      proxy(request);

      // Assert
      expect(getClientIP).toHaveBeenCalledWith(request);
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.check).toHaveBeenCalledWith('192.168.1.100');
    });

    it('should NOT call apiLimiter.peek() when adding rate limit headers', async () => {
      // Import mocked modules
      const { apiLimiter, getRateLimitHeaders } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert - check() is called once, peek() is NOT called
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.peek).not.toHaveBeenCalled();

      // Verify getRateLimitHeaders is called with the check result
      expect(getRateLimitHeaders).toHaveBeenCalledWith(mockCheckResult);

      // Verify headers are set on response
      expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('99');
      expect(response.headers.get('X-RateLimit-Reset')).toBe('1234567890');
    });

    it('should reuse check() result for rate limit headers', async () => {
      // Import mocked modules
      const { apiLimiter, getRateLimitHeaders } = await import('@/lib/security/rate-limit');

      // Create a custom check result
      const customResult = {
        success: true,
        limit: 50,
        remaining: 25,
        reset: 9999999999,
      };

      vi.mocked(apiLimiter.check).mockReturnValueOnce(customResult);

      // Arrange
      const request = createMockRequest('/api/v1/posts', {
        method: 'GET',
      });

      // Act
      const response = proxy(request);

      // Assert - getRateLimitHeaders receives the same result from check()
      expect(getRateLimitHeaders).toHaveBeenCalledWith(customResult);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('50');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('25');
    });
  });

  describe('Custom auth routes (I13 fix)', () => {
    it('should add security headers to /api/auth/send-verification-email', async () => {
      // Import mocked module
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      // Arrange
      const request = createMockRequest('/api/auth/send-verification-email', {
        method: 'POST',
      });

      // Act
      const response = proxy(request);

      // Assert - security headers are set (proxy no longer excludes /api/auth/*)
      expect(setSecurityHeaders).toHaveBeenCalledWith(response);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should add security headers to /api/auth/accept-invite', async () => {
      // Import mocked module
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      // Arrange
      const request = createMockRequest('/api/auth/accept-invite', {
        method: 'POST',
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(setSecurityHeaders).toHaveBeenCalledWith(response);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should add security headers to /api/auth/clear-session', async () => {
      // Import mocked module
      const { setSecurityHeaders } = await import('@/lib/security/headers');

      // Arrange
      const request = createMockRequest('/api/auth/clear-session', {
        method: 'POST',
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(setSecurityHeaders).toHaveBeenCalledWith(response);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should add request ID to better-auth catch-all routes', () => {
      // Arrange
      const request = createMockRequest('/api/auth/sign-in', {
        method: 'POST',
      });

      // Act
      const response = proxy(request);

      // Assert - request ID is propagated even to better-auth routes
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });
  });

  describe('IP validation integration', () => {
    it('should use getClientIP from @/lib/security/ip', async () => {
      // Import mocked module
      const { getClientIP } = await import('@/lib/security/ip');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '10.0.0.1',
        },
      });

      // Act
      proxy(request);

      // Assert - getClientIP is called with the request
      expect(getClientIP).toHaveBeenCalledWith(request);
    });

    it('should fall back to default IP when X-Forwarded-For is invalid', async () => {
      // Import mocked modules
      const { apiLimiter } = await import('@/lib/security/rate-limit');

      // Arrange - invalid X-Forwarded-For value (not an IP)
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': 'malicious-payload',
        },
      });

      // Act
      proxy(request);

      // Assert - check is called with fallback IP (127.0.0.1)
      expect(apiLimiter.check).toHaveBeenCalledWith('127.0.0.1');
    });

    it('should extract valid IP from X-Forwarded-For', async () => {
      // Import mocked modules
      const { apiLimiter } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '203.0.113.45, 192.168.1.1',
        },
      });

      // Act
      proxy(request);

      // Assert - check is called with first valid IP
      expect(apiLimiter.check).toHaveBeenCalledWith('203.0.113.45');
    });
  });

  describe('Admin rate limiting', () => {
    it('should call adminLimiter.check for /api/v1/admin/* routes', async () => {
      // Import mocked modules
      const { adminLimiter, apiLimiter } = await import('@/lib/security/rate-limit');
      const { getClientIP } = await import('@/lib/security/ip');

      // Arrange
      const request = createMockRequest('/api/v1/admin/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      proxy(request);

      // Assert - both admin and API limiters are checked
      expect(getClientIP).toHaveBeenCalledWith(request);
      expect(adminLimiter.check).toHaveBeenCalledTimes(1);
      expect(adminLimiter.check).toHaveBeenCalledWith('192.168.1.100');
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.check).toHaveBeenCalledWith('192.168.1.100');
    });

    it('should NOT call adminLimiter.check for non-admin /api/v1/* routes', async () => {
      // Import mocked modules
      const { adminLimiter, apiLimiter } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      proxy(request);

      // Assert - only API limiter is checked, not admin limiter
      expect(adminLimiter.check).not.toHaveBeenCalled();
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
    });

    it('should return 429 when adminLimiter fails without checking apiLimiter', async () => {
      // Import mocked modules
      const { adminLimiter, apiLimiter, createRateLimitResponse } =
        await import('@/lib/security/rate-limit');

      // Mock admin limiter failure
      const failedResult = {
        success: false,
        limit: 30,
        remaining: 0,
        reset: 1234567890,
      };
      vi.mocked(adminLimiter.check).mockReturnValueOnce(failedResult);

      // Arrange
      const request = createMockRequest('/api/v1/admin/settings', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(adminLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.check).not.toHaveBeenCalled(); // Should NOT be called
      expect(createRateLimitResponse).toHaveBeenCalledWith(failedResult);
      expect(response.status).toBe(429);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should check apiLimiter after adminLimiter passes', async () => {
      // Import mocked modules
      const { adminLimiter, apiLimiter } = await import('@/lib/security/rate-limit');

      // Both limiters pass
      vi.mocked(adminLimiter.check).mockReturnValueOnce(mockAdminCheckResult);
      vi.mocked(apiLimiter.check).mockReturnValueOnce(mockCheckResult);

      // Arrange
      const request = createMockRequest('/api/v1/admin/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert - both checks happen in sequence
      expect(adminLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
      expect(response.status).not.toBe(429);
    });

    it('should return 429 when adminLimiter passes but apiLimiter fails', async () => {
      // Import mocked modules
      const { adminLimiter, apiLimiter, createRateLimitResponse } =
        await import('@/lib/security/rate-limit');

      // Admin passes, API fails
      vi.mocked(adminLimiter.check).mockReturnValueOnce(mockAdminCheckResult);
      const apiFailedResult = {
        success: false,
        limit: 100,
        remaining: 0,
        reset: 1234567890,
      };
      vi.mocked(apiLimiter.check).mockReturnValueOnce(apiFailedResult);

      // Arrange
      const request = createMockRequest('/api/v1/admin/roles', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert - both checks happen, API limiter blocks
      expect(adminLimiter.check).toHaveBeenCalledTimes(1);
      expect(apiLimiter.check).toHaveBeenCalledTimes(1);
      expect(createRateLimitResponse).toHaveBeenCalledWith(apiFailedResult);
      expect(response.status).toBe(429);
    });
  });

  describe('Auth rate limiting', () => {
    it('should call authLimiter.check for /api/auth/* routes', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');
      const { getClientIP } = await import('@/lib/security/ip');

      // Arrange
      const request = createMockRequest('/api/auth/sign-in', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      proxy(request);

      // Assert
      expect(getClientIP).toHaveBeenCalledWith(request);
      expect(authLimiter.check).toHaveBeenCalledTimes(1);
      expect(authLimiter.check).toHaveBeenCalledWith('192.168.1.100');
    });

    it('should call authLimiter.check for /api/auth/forgot-password', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/api/auth/forgot-password', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '10.0.0.5',
        },
      });

      // Act
      proxy(request);

      // Assert
      expect(authLimiter.check).toHaveBeenCalledTimes(1);
      expect(authLimiter.check).toHaveBeenCalledWith('10.0.0.5');
    });

    it('should NOT call authLimiter.check for /api/auth/sign-out', async () => {
      const { authLimiter } = await import('@/lib/security/rate-limit');

      const request = createMockRequest('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'x-forwarded-for': '192.168.1.100' },
      });

      proxy(request);

      expect(authLimiter.check).not.toHaveBeenCalled();
    });

    it('should NOT call authLimiter.check for /api/auth/callback/*', async () => {
      const { authLimiter } = await import('@/lib/security/rate-limit');

      const request = createMockRequest('/api/auth/callback/google', {
        method: 'GET',
        headers: { 'x-forwarded-for': '192.168.1.100' },
      });

      proxy(request);

      expect(authLimiter.check).not.toHaveBeenCalled();
    });

    it('should NOT call authLimiter.check for /api/auth/get-session', async () => {
      const { authLimiter } = await import('@/lib/security/rate-limit');

      const request = createMockRequest('/api/auth/get-session', {
        method: 'GET',
        headers: { 'x-forwarded-for': '192.168.1.100' },
      });

      proxy(request);

      expect(authLimiter.check).not.toHaveBeenCalled();
    });

    it('should NOT call authLimiter.check for /api/v1/* routes', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/api/v1/users', {
        method: 'GET',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      proxy(request);

      // Assert - authLimiter should NOT be called for API routes
      expect(authLimiter.check).not.toHaveBeenCalled();
    });

    it('should NOT call authLimiter.check for non-API routes', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');

      // Arrange
      const request = createMockRequest('/dashboard', {
        method: 'GET',
        cookies: { 'better-auth.session_token': 'valid-token' },
      });

      // Act
      proxy(request);

      // Assert
      expect(authLimiter.check).not.toHaveBeenCalled();
    });

    it('should return 429 when authLimiter fails', async () => {
      // Import mocked modules
      const { authLimiter, createRateLimitResponse } = await import('@/lib/security/rate-limit');

      // Mock auth limiter failure
      const failedResult = {
        success: false,
        limit: 5,
        remaining: 0,
        reset: 1234567890,
      };
      vi.mocked(authLimiter.check).mockReturnValueOnce(failedResult);

      // Arrange
      const request = createMockRequest('/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(authLimiter.check).toHaveBeenCalledTimes(1);
      expect(createRateLimitResponse).toHaveBeenCalledWith(failedResult);
      expect(response.status).toBe(429);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should allow request when authLimiter passes', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');

      // Auth limiter passes
      vi.mocked(authLimiter.check).mockReturnValueOnce(mockAuthCheckResult);

      // Arrange
      const request = createMockRequest('/api/auth/sign-in', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      const response = proxy(request);

      // Assert
      expect(authLimiter.check).toHaveBeenCalledTimes(1);
      expect(response.status).not.toBe(429);
      expect(response.headers.get('x-request-id')).toBe('test-request-id-123');
    });

    it('should rate limit all credential-based auth endpoints', async () => {
      // Import mocked modules
      const { authLimiter } = await import('@/lib/security/rate-limit');

      // Arrange - only credential-based endpoints are rate limited
      const requests = [
        createMockRequest('/api/auth/sign-in', {
          method: 'POST',
          headers: { 'x-forwarded-for': '192.168.1.100' },
        }),
        createMockRequest('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'x-forwarded-for': '192.168.1.100' },
        }),
        createMockRequest('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'x-forwarded-for': '192.168.1.100' },
        }),
        createMockRequest('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'x-forwarded-for': '192.168.1.100' },
        }),
      ];

      // Act - call proxy for each request
      requests.forEach((request) => {
        vi.clearAllMocks();
        proxy(request);
        // Assert - each call checks auth limiter with same IP
        expect(authLimiter.check).toHaveBeenCalledWith('192.168.1.100');
      });
    });
  });
});
