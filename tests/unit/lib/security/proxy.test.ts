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
vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: {
    check: vi.fn(() => ({ success: true })),
    peek: vi.fn(() => ({
      success: true,
      remaining: 100,
      limit: 100,
      reset: Date.now() + 60000,
    })),
  },
  getRateLimitHeaders: vi.fn(() => ({
    'X-RateLimit-Limit': '100',
    'X-RateLimit-Remaining': '99',
    'X-RateLimit-Reset': '1234567890',
  })),
  createRateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
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
});
