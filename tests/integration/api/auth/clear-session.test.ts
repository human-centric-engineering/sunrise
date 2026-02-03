/**
 * Integration Test: Clear Session Endpoint
 *
 * Tests the /api/auth/clear-session endpoint that removes invalid session cookies
 * and redirects to login. Used when a user's session cookie exists but their
 * account or session has been deleted, preventing infinite redirect loops.
 *
 * Test Coverage:
 * GET /api/auth/clear-session:
 * - Deletes HTTP session cookies (better-auth.session_token, better-auth.session_data, better-auth.csrf_token, better-auth.state)
 * - Deletes HTTPS session cookies (__Secure-better-auth.session_token, __Secure-better-auth.session_data, __Secure-better-auth.csrf_token, __Secure-better-auth.state)
 * - Redirects to login with returnUrl parameter
 * - Uses default returnUrl if not provided
 *
 * @see app/api/auth/clear-session/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/auth/clear-session/route';
import type { NextRequest } from 'next/server';

/**
 * Mock dependencies
 */

// Mock next/headers
const mockCookieStore = {
  delete: vi.fn(),
  set: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

/**
 * Helper function to create a mock NextRequest for GET
 */
function createMockGetRequest(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/auth/clear-session');

  // Add search params
  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe('GET /api/auth/clear-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Cookie Deletion', () => {
    it('should delete HTTP session cookies (better-auth.session_token)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
    });

    it('should delete HTTP CSRF cookie (better-auth.csrf_token)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.csrf_token');
    });

    it('should expire HTTPS session cookie with Secure attribute (__Secure-better-auth.session_token)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert - uses set() with secure: true so browsers accept the deletion
      expect(mockCookieStore.set).toHaveBeenCalledWith('__Secure-better-auth.session_token', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should expire HTTPS CSRF cookie with Secure attribute (__Secure-better-auth.csrf_token)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.set).toHaveBeenCalledWith('__Secure-better-auth.csrf_token', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should delete HTTP session data cookie (better-auth.session_data)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_data');
    });

    it('should delete HTTP state cookie (better-auth.state)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.state');
    });

    it('should expire HTTPS session data cookie with Secure attribute (__Secure-better-auth.session_data)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.set).toHaveBeenCalledWith('__Secure-better-auth.session_data', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should expire HTTPS state cookie with Secure attribute (__Secure-better-auth.state)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert
      expect(mockCookieStore.set).toHaveBeenCalledWith('__Secure-better-auth.state', '', {
        path: '/',
        secure: true,
        maxAge: 0,
      });
    });

    it('should delete all eight cookie variants (4 via delete, 4 via set with Secure)', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      await GET(request);

      // Assert - HTTP cookies use delete()
      expect(mockCookieStore.delete).toHaveBeenCalledTimes(4);
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_token');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.session_data');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.csrf_token');
      expect(mockCookieStore.delete).toHaveBeenCalledWith('better-auth.state');
      // HTTPS __Secure- cookies use set() with secure: true (browsers require Secure attribute)
      const secureCookieOptions = { path: '/', secure: true, maxAge: 0 };
      expect(mockCookieStore.set).toHaveBeenCalledTimes(4);
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.session_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.session_data',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.csrf_token',
        '',
        secureCookieOptions
      );
      expect(mockCookieStore.set).toHaveBeenCalledWith(
        '__Secure-better-auth.state',
        '',
        secureCookieOptions
      );
    });
  });

  describe('Redirect Behavior', () => {
    it('should redirect to login page', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(307); // Temporary redirect
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should include returnUrl in login redirect when provided', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: '/dashboard' });

      // Act
      const response = await GET(request);

      // Assert
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2Fdashboard');
    });

    it('should include complex returnUrl in login redirect', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: '/settings?tab=profile' });

      // Act
      const response = await GET(request);

      // Assert
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=');
    });

    it('should use default returnUrl (/) when not provided', async () => {
      // Arrange
      const request = createMockGetRequest();

      // Act
      const response = await GET(request);

      // Assert
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=%2F'); // URL-encoded /
    });

    it('should use x-forwarded-proto and host headers for redirect URL', async () => {
      // Arrange - simulate reverse proxy (e.g. ngrok) forwarding
      const url = new URL('http://localhost:3000/api/auth/clear-session');
      const request = {
        nextUrl: url,
        url: url.toString(),
        headers: new Headers({
          host: 'abc123.ngrok.io',
          'x-forwarded-proto': 'https',
        }),
      } as unknown as NextRequest;

      // Act
      const response = await GET(request);

      // Assert - redirect should use the forwarded origin, not localhost
      const location = response.headers.get('location');
      expect(location).toContain('https://abc123.ngrok.io/login');
      expect(location).not.toContain('localhost');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty returnUrl parameter', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: '' });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
    });

    it('should handle protected route returnUrl', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: '/admin/users' });

      // Act
      const response = await GET(request);

      // Assert
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('callbackUrl=');
    });
  });

  describe('Security', () => {
    it('should block external returnUrl to prevent open redirect', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: 'https://evil.com/phish' });

      // Act
      const response = await GET(request);

      // Assert - should redirect to login with safe fallback, not the external URL
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).not.toContain('evil.com');
      expect(location).toContain('callbackUrl=%2F'); // Falls back to /
    });

    it('should block protocol-relative returnUrl', async () => {
      // Arrange
      const request = createMockGetRequest({ returnUrl: '//evil.com/phish' });

      // Act
      const response = await GET(request);

      // Assert
      const location = response.headers.get('location');
      expect(location).not.toContain('evil.com');
    });

    it('should not expose internal errors in response', async () => {
      // Arrange
      mockCookieStore.delete.mockImplementation(() => {
        throw new Error('Cookie deletion failed');
      });
      const request = createMockGetRequest();

      // Act & Assert
      await expect(GET(request)).rejects.toThrow();
    });
  });
});
