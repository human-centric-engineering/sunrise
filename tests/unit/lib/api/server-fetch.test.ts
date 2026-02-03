/**
 * Unit Tests: Server Fetch Utilities
 *
 * Tests the server-side fetch utilities for API calls from Server Components.
 *
 * Test Coverage:
 * - getCookieHeader() - Cookie serialization from Next.js cookies
 * - getBaseUrl() - Base URL retrieval from environment
 * - serverFetch() - Fetch with cookie forwarding and cache options
 *
 * @see lib/api/server-fetch.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCookieHeader, getBaseUrl, serverFetch } from '@/lib/api/server-fetch';

/**
 * Mock dependencies
 */

// Mock Next.js headers
vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

// Mock environment
vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

// Import mocked modules
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Mock cookie store helper
 */
interface MockCookie {
  name: string;
  value: string;
}

function createMockCookieStore(cookieList: MockCookie[]) {
  return {
    getAll: vi.fn(() => cookieList),
  };
}

/**
 * Test Suite: getCookieHeader
 */
describe('getCookieHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should serialize multiple cookies correctly', async () => {
    // Arrange
    const mockCookies = [
      { name: 'session_token', value: 'abc123' },
      { name: 'user_id', value: 'xyz789' },
      { name: 'theme', value: 'dark' },
    ];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);

    // Act
    const result = await getCookieHeader();

    // Assert
    expect(result).toBe('session_token=abc123; user_id=xyz789; theme=dark');
  });

  it('should return empty string when no cookies exist', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);

    // Act
    const result = await getCookieHeader();

    // Assert
    expect(result).toBe('');
  });

  it('should handle single cookie', async () => {
    // Arrange
    const mockCookies = [{ name: 'session', value: 'token123' }];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);

    // Act
    const result = await getCookieHeader();

    // Assert
    expect(result).toBe('session=token123');
  });

  it('should call cookies() from next/headers', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);

    // Act
    await getCookieHeader();

    // Assert
    expect(cookies).toHaveBeenCalledOnce();
  });

  it('should handle cookies with special characters in values', async () => {
    // Arrange
    const mockCookies = [
      { name: 'token', value: 'abc-123_xyz.456' },
      { name: 'data', value: 'value%20with%20encoding' },
    ];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);

    // Act
    const result = await getCookieHeader();

    // Assert
    expect(result).toBe('token=abc-123_xyz.456; data=value%20with%20encoding');
  });
});

/**
 * Test Suite: getBaseUrl
 */
describe('getBaseUrl', () => {
  it('should return the BETTER_AUTH_URL from env', () => {
    // Act
    const result = getBaseUrl();

    // Assert
    expect(result).toBe('http://localhost:3000');
  });

  it('should not include trailing slash', () => {
    // Act
    const result = getBaseUrl();

    // Assert
    expect(result).not.toMatch(/\/$/);
  });

  it('should return the exact value from env.BETTER_AUTH_URL', () => {
    // Act
    const result = getBaseUrl();

    // Assert
    expect(result).toBe(env.BETTER_AUTH_URL);
  });
});

/**
 * Test Suite: serverFetch
 */
describe('serverFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  it('should call fetch with correct absolute URL (baseUrl + path)', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/users',
      expect.any(Object)
    );
  });

  it('should forward cookies in the Cookie header', async () => {
    // Arrange
    const mockCookies = [
      { name: 'session_token', value: 'abc123' },
      { name: 'user_id', value: 'xyz789' },
    ];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/admin/stats');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/admin/stats',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'session_token=abc123; user_id=xyz789',
        }),
      })
    );
  });

  it('should default to cache: no-store', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cache: 'no-store',
      })
    );
  });

  it('should allow overriding cache option via init', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users', { cache: 'force-cache' });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cache: 'force-cache',
      })
    );
  });

  it('should merge additional headers from init', async () => {
    // Arrange
    const mockCookies = [{ name: 'session', value: 'token123' }];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users', {
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'custom-value',
      },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          Cookie: 'session=token123',
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
        },
      })
    );
  });

  it('should pass through other init options (method, body, etc.)', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);
    const requestBody = JSON.stringify({ name: 'John', email: 'john@example.com' });

    // Act
    await serverFetch('/api/v1/users/invite', {
      method: 'POST',
      body: requestBody,
      headers: { 'Content-Type': 'application/json' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/users/invite',
      expect.objectContaining({
        method: 'POST',
        body: requestBody,
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('should handle paths with query parameters', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users?limit=20&sortBy=createdAt');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/users?limit=20&sortBy=createdAt',
      expect.any(Object)
    );
  });

  it('should return the fetch Response', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockResponse = new Response(JSON.stringify({ data: 'test' }));
    vi.mocked(global.fetch).mockResolvedValue(mockResponse);

    // Act
    const result = await serverFetch('/api/v1/users');

    // Assert
    expect(result).toBe(mockResponse);
  });

  it('should handle empty cookie header when no cookies exist', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: '',
        }),
      })
    );
  });

  it('should handle fetch without init parameter', async () => {
    // Arrange
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore([]) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/users',
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          Cookie: '',
        }),
      })
    );
  });

  it('should preserve cookie header when init.headers is provided', async () => {
    // Arrange
    const mockCookies = [{ name: 'auth', value: 'token' }];
    vi.mocked(cookies).mockResolvedValue(createMockCookieStore(mockCookies) as any);
    const mockFetch = vi.mocked(global.fetch);

    // Act
    await serverFetch('/api/v1/users', {
      headers: { 'X-Custom': 'value' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          Cookie: 'auth=token',
          'X-Custom': 'value',
        },
      })
    );
  });
});
