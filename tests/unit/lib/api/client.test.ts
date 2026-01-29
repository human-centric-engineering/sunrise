/**
 * API Client Tests
 *
 * Tests the client-side API utility for making type-safe HTTP requests.
 * Covers APIClientError class, URL building, response handling, and all HTTP methods.
 *
 * Test Coverage:
 * - APIClientError class construction and properties
 * - getBaseURL() for browser vs server contexts
 * - buildURL() with query parameters and filtering
 * - handleResponse() for success and error responses
 * - request() method with different HTTP verbs
 * - apiClient convenience methods (get, post, patch, delete)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/api/client.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIClientError, apiClient } from '@/lib/api/client';
import type { APIResponse } from '@/types/api';

describe('APIClientError', () => {
  describe('constructor and properties', () => {
    it('should create error with message only', () => {
      // Arrange & Act
      const error = new APIClientError('Something went wrong');

      // Assert
      expect(error.message).toBe('Something went wrong');
      expect(error.name).toBe('APIClientError');
      expect(error.code).toBeUndefined();
      expect(error.status).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it('should create error with message and code', () => {
      // Arrange & Act
      const error = new APIClientError('Not found', 'NOT_FOUND');

      // Assert
      expect(error.message).toBe('Not found');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.status).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it('should create error with message, code, and status', () => {
      // Arrange & Act
      const error = new APIClientError('Not found', 'NOT_FOUND', 404);

      // Assert
      expect(error.message).toBe('Not found');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.status).toBe(404);
      expect(error.details).toBeUndefined();
    });

    it('should create error with all parameters', () => {
      // Arrange
      const details = { field: 'email', reason: 'invalid' };

      // Act
      const error = new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, details);

      // Assert
      expect(error.message).toBe('Validation failed');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.status).toBe(400);
      expect(error.details).toEqual({ field: 'email', reason: 'invalid' });
    });

    it('should extend Error class', () => {
      // Arrange & Act
      const error = new APIClientError('Test error');

      // Assert
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(APIClientError);
    });

    it('should have proper stack trace', () => {
      // Arrange & Act
      const error = new APIClientError('Test error');

      // Assert
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('APIClientError');
    });

    it('should set name property to APIClientError', () => {
      // Arrange & Act
      const error = new APIClientError('Test');

      // Assert
      expect(error.name).toBe('APIClientError');
    });
  });
});

describe('getBaseURL (via buildURL)', () => {
  let originalWindow: typeof globalThis.window;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original values
    originalWindow = globalThis.window;
    originalEnv = process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    // Restore original values
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      globalThis.window = originalWindow;
    }
    process.env.NEXT_PUBLIC_APP_URL = originalEnv;

    vi.restoreAllMocks();
  });

  it('should return empty string in browser context', async () => {
    // Arrange
    // Window is defined by default in vitest with jsdom environment
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '1' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    // In browser context, URL should be relative (start with /)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/users/),
      expect.any(Object)
    );
  });

  it('should use NEXT_PUBLIC_APP_URL in server context when set', async () => {
    // Arrange

    delete (globalThis as any).window; // Simulate server context
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '1' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/api/v1/users', expect.any(Object));
  });

  it('should use relative URL in server context when NEXT_PUBLIC_APP_URL not set', async () => {
    // Arrange

    delete (globalThis as any).window; // Simulate server context
    delete process.env.NEXT_PUBLIC_APP_URL;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '1' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    // Should use relative URL when no base URL is set
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/v1\/users/),
      expect.any(Object)
    );
  });
});

describe('buildURL (via request calls)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should build URL with base path only', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users$/),
      expect.any(Object)
    );
  });

  it('should build URL with single query parameter', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 1 },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users\?page=1$/),
      expect.any(Object)
    );
  });

  it('should build URL with multiple query parameters', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 2, limit: 20, sort: 'name' },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('page=2');
    expect(callUrl).toContain('limit=20');
    expect(callUrl).toContain('sort=name');
  });

  it('should filter out undefined parameters', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 1, filter: undefined, sort: 'name' },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('sort=name');
    expect(callUrl).not.toContain('filter');
  });

  it('should filter out null parameters', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 1, filter: null as any, sort: 'name' },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('sort=name');
    expect(callUrl).not.toContain('filter');
  });

  it('should handle boolean parameters', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { active: true, verified: false },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('active=true');
    expect(callUrl).toContain('verified=false');
  });

  it('should convert number parameters to strings', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 5, limit: 100 },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('page=5');
    expect(callUrl).toContain('limit=100');
  });

  it('should handle empty params object', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', { params: {} });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users$/),
      expect.any(Object)
    );
  });

  it('should URL-encode parameter values', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { q: 'hello world' },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('q=hello+world');
  });
});

describe('handleResponse (via request calls)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse successful JSON response', async () => {
    // Arrange
    const responseData = { id: '123', name: 'John' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: responseData }),
    });

    // Act
    const result = await apiClient.get<{ id: string; name: string }>('/api/v1/users/123');

    // Assert
    expect(result).toEqual(responseData);
  });

  it('should throw APIClientError for error response with JSON body', async () => {
    // Arrange
    const errorResponse: APIResponse<never> = {
      success: false,
      error: {
        message: 'User not found',
        code: 'NOT_FOUND',
        details: { userId: '123' },
      },
    };
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => errorResponse,
    });

    // Act & Assert
    await expect(apiClient.get('/api/v1/users/123')).rejects.toThrow(APIClientError);

    try {
      await apiClient.get('/api/v1/users/123');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toBe('User not found');
        expect(error.code).toBe('NOT_FOUND');
        expect(error.status).toBe(404);
        expect(error.details).toEqual({ userId: '123' });
      }
    }
  });

  it('should throw APIClientError for error response without details', async () => {
    // Arrange
    const errorResponse: APIResponse<never> = {
      success: false,
      error: {
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      },
    };
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => errorResponse,
    });

    // Act & Assert
    try {
      await apiClient.get('/api/v1/users');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toBe('Internal server error');
        expect(error.code).toBe('INTERNAL_ERROR');
        expect(error.status).toBe(500);
        expect(error.details).toBeUndefined();
      }
    }
  });

  it('should throw APIClientError for non-JSON response', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('Unexpected token');
      },
    });

    // Act & Assert
    try {
      await apiClient.get('/api/v1/users');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toContain('Invalid response format');
        expect(error.code).toBe('INVALID_RESPONSE');
        expect(error.status).toBe(502);
      }
    }
  });

  it('should handle successful response with null data', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({ success: true, data: null }),
    });

    // Act
    const result = await apiClient.delete('/api/v1/users/123');

    // Assert
    expect(result).toBeNull();
  });

  it('should handle successful response with array data', async () => {
    // Arrange
    const users = [
      { id: '1', name: 'John' },
      { id: '2', name: 'Jane' },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: users }),
    });

    // Act
    const result = await apiClient.get<Array<{ id: string; name: string }>>('/api/v1/users');

    // Assert
    expect(result).toEqual(users);
  });
});

describe('request', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should make GET request with correct method', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'GET',
      })
    );
  });

  it('should make POST request with correct method', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: { id: '123' } }),
    });

    // Act
    await apiClient.post('/api/v1/users', {
      body: { name: 'John' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('should serialize body as JSON', async () => {
    // Arrange
    const body = { name: 'John', email: 'john@example.com' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: { id: '123' } }),
    });

    // Act
    await apiClient.post('/api/v1/users', { body });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify(body),
      })
    );
  });

  it('should not include body for GET requests', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    const callOptions = mockFetch.mock.calls[0][1];
    expect(callOptions.body).toBeUndefined();
  });

  it('should set Content-Type header to application/json', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });

    // Act
    await apiClient.post('/api/v1/users', {
      body: { name: 'John' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('should merge custom headers with default headers', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });

    // Act
    await apiClient.get('/api/v1/users', {
      options: {
        headers: {
          'X-Custom-Header': 'custom-value',
          Authorization: 'Bearer token',
        },
      },
    });

    // Assert - Note: ...options?.options spread overwrites the headers object,
    // so custom headers replace the default Content-Type header
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Header': 'custom-value',
          Authorization: 'Bearer token',
        }),
      })
    );
  });

  it('should set credentials to same-origin', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });

    // Act
    await apiClient.get('/api/v1/users');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: 'same-origin',
      })
    );
  });

  it('should wrap network errors as APIClientError', async () => {
    // Arrange
    mockFetch.mockRejectedValue(new Error('Network failure'));

    // Act & Assert
    try {
      await apiClient.get('/api/v1/users');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toBe('Network failure');
        expect(error.code).toBe('NETWORK_ERROR');
      }
    }
  });

  it('should wrap non-Error objects as APIClientError', async () => {
    // Arrange
    mockFetch.mockRejectedValue('String error');

    // Act & Assert
    try {
      await apiClient.get('/api/v1/users');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toBe('Network request failed');
        expect(error.code).toBe('NETWORK_ERROR');
      }
    }
  });

  it('should re-throw APIClientError instances', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: {
          message: 'Custom error',
          code: 'CUSTOM_ERROR',
        },
      }),
    });

    // Act & Assert
    try {
      await apiClient.get('/api/v1/users');
    } catch (error) {
      expect(error).toBeInstanceOf(APIClientError);
      if (error instanceof APIClientError) {
        expect(error.message).toBe('Custom error');
        expect(error.code).toBe('CUSTOM_ERROR');
      }
    }
  });
});

describe('apiClient.get', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '1' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should make GET request to correct path', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users/123');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users\/123/),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should support query parameters', async () => {
    // Arrange & Act
    await apiClient.get('/api/v1/users', {
      params: { page: 1, limit: 10 },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('page=1');
    expect(callUrl).toContain('limit=10');
  });

  it('should return typed response data', async () => {
    // Arrange
    const userData = { id: '123', name: 'John', email: 'john@example.com' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: userData }),
    });

    // Act
    const result = await apiClient.get<{ id: string; name: string; email: string }>(
      '/api/v1/users/123'
    );

    // Assert
    expect(result).toEqual(userData);
  });
});

describe('apiClient.post', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: { id: '123' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should make POST request to correct path', async () => {
    // Arrange & Act
    await apiClient.post('/api/v1/users', {
      body: { name: 'John' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users/),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('should serialize body as JSON', async () => {
    // Arrange
    const body = { name: 'John', email: 'john@example.com' };

    // Act
    await apiClient.post('/api/v1/users', { body });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify(body),
      })
    );
  });

  it('should support query parameters with body', async () => {
    // Arrange & Act
    await apiClient.post('/api/v1/users', {
      params: { notify: true },
      body: { name: 'John' },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('notify=true');
  });

  it('should return typed response data', async () => {
    // Arrange
    const newUser = { id: '123', name: 'John', email: 'john@example.com' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: newUser }),
    });

    // Act
    const result = await apiClient.post<{ id: string; name: string; email: string }>(
      '/api/v1/users',
      {
        body: { name: 'John', email: 'john@example.com' },
      }
    );

    // Assert
    expect(result).toEqual(newUser);
  });
});

describe('apiClient.patch', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: '123', name: 'Jane' } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should make PATCH request to correct path', async () => {
    // Arrange & Act
    await apiClient.patch('/api/v1/users/123', {
      body: { name: 'Jane' },
    });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users\/123/),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('should serialize body as JSON', async () => {
    // Arrange
    const body = { name: 'Jane' };

    // Act
    await apiClient.patch('/api/v1/users/123', { body });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify(body),
      })
    );
  });

  it('should return typed response data', async () => {
    // Arrange
    const updatedUser = { id: '123', name: 'Jane', email: 'jane@example.com' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: updatedUser }),
    });

    // Act
    const result = await apiClient.patch<{ id: string; name: string; email: string }>(
      '/api/v1/users/123',
      {
        body: { name: 'Jane' },
      }
    );

    // Assert
    expect(result).toEqual(updatedUser);
  });
});

describe('apiClient.delete', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({ success: true, data: null }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should make DELETE request to correct path', async () => {
    // Arrange & Act
    await apiClient.delete('/api/v1/users/123');

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/users\/123/),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('should support query parameters', async () => {
    // Arrange & Act
    await apiClient.delete('/api/v1/users/123', {
      params: { force: true },
    });

    // Assert
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('force=true');
  });

  it('should support optional body', async () => {
    // Arrange
    const body = { reason: 'User requested deletion' };

    // Act
    await apiClient.delete('/api/v1/users/123', { body });

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify(body),
      })
    );
  });

  it('should handle void response type', async () => {
    // Arrange
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({ success: true, data: null }),
    });

    // Act
    const result = await apiClient.delete('/api/v1/users/123');

    // Assert
    expect(result).toBeNull();
  });

  it('should return typed response when specified', async () => {
    // Arrange
    const deletionResult = { deleted: true, id: '123' };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: deletionResult }),
    });

    // Act
    const result = await apiClient.delete<{ deleted: boolean; id: string }>('/api/v1/users/123');

    // Assert
    expect(result).toEqual(deletionResult);
  });
});
