/**
 * Logging Context Utilities Tests
 *
 * Tests for context utilities in lib/logging/context.ts
 * - generateRequestId() - Unique request ID generation
 * - getRequestId() - Request ID extraction from headers
 * - getRequestContext() - Full request context
 * - getUserContext() - User/session context from auth
 * - getFullContext() - Combined request + user context
 * - getEndpointPath() - Extract clean endpoint path
 * - getClientIp() - Extract client IP from various headers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateRequestId,
  getRequestId,
  getRequestContext,
  getUserContext,
  getFullContext,
  getEndpointPath,
  getClientIp,
} from '@/lib/logging/context';
import { createMockHeaders } from '@/tests/types/mocks';

// Mock dependencies
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn((size: number) => 'a'.repeat(size)),
}));

// Import mocked modules for type safety
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { nanoid } from 'nanoid';

describe('Logging Context Utilities', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateRequestId()', () => {
    it('should generate a 16-character request ID', () => {
      // Act
      const id = generateRequestId();

      // Assert
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.length).toBe(16);
    });

    it('should generate unique IDs on multiple calls', () => {
      // Mock nanoid to return different values
      vi.mocked(nanoid).mockImplementationOnce(() => 'id1_____________');
      vi.mocked(nanoid).mockImplementationOnce(() => 'id2_____________');

      // Act
      const id1 = generateRequestId();
      const id2 = generateRequestId();

      // Assert
      expect(id1).not.toBe(id2);
    });

    it('should use nanoid with size 16', () => {
      // Act
      generateRequestId();

      // Assert
      expect(nanoid).toHaveBeenCalledWith(16);
    });
  });

  describe('getRequestId()', () => {
    it('should return existing request ID from headers', async () => {
      // Arrange
      const existingId = 'existing-req-id';
      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({ 'x-request-id': existingId }) as any
      );

      // Act
      const id = await getRequestId();

      // Assert
      expect(id).toBe(existingId);
    });

    it('should generate new ID if header is missing', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const id = await getRequestId();

      // Assert
      expect(id).toBeDefined();
      expect(id.length).toBe(16);
    });

    it('should call headers() to get header list', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      await getRequestId();

      // Assert
      expect(headers).toHaveBeenCalled();
    });

    it('should check x-request-id header specifically', async () => {
      // Arrange
      const mockGet = vi.fn();
      vi.mocked(headers).mockResolvedValue({
        get: mockGet,
      } as any);

      // Act
      await getRequestId();

      // Assert
      expect(mockGet).toHaveBeenCalledWith('x-request-id');
    });
  });

  describe('getRequestContext()', () => {
    it('should extract full request context with request object', async () => {
      // Arrange
      const mockRequest = {
        method: 'POST',
        url: 'http://localhost:3000/api/users',
      } as Request;

      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({
          'x-request-id': 'req-123',
          'user-agent': 'Mozilla/5.0',
        }) as any
      );

      // Act
      const context = await getRequestContext(mockRequest);

      // Assert
      expect(context).toEqual({
        requestId: 'req-123',
        method: 'POST',
        url: 'http://localhost:3000/api/users',
        userAgent: 'Mozilla/5.0',
      } as any);
    });

    it('should work without request object', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-request-id': 'req-456' }).get,
      } as any);

      // Act
      const context = await getRequestContext();

      // Assert
      expect(context.requestId).toBe('req-456');
      expect(context.method).toBeUndefined();
      expect(context.url).toBeUndefined();
      expect(context.userAgent).toBeUndefined();
    });

    it('should generate request ID if not in headers', async () => {
      // Arrange
      const mockRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/health',
      } as Request;

      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const context = await getRequestContext(mockRequest);

      // Assert
      expect(context.requestId).toBeDefined();
      expect(context.requestId.length).toBe(16);
    });

    it('should handle missing user agent gracefully', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-request-id': 'req-789' }).get,
      } as any);

      // Act
      const context = await getRequestContext();

      // Assert
      expect(context.userAgent).toBeUndefined();
    });
  });

  describe('getUserContext()', () => {
    it('should return user context when authenticated', async () => {
      // Arrange
      const mockSession = {
        user: {
          id: 'user-123',
          email: 'john@example.com',
        },
        session: {
          id: 'session-456',
        },
      };

      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as any);
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const context = await getUserContext();

      // Assert
      expect(context).toEqual({
        userId: 'user-123',
        sessionId: 'session-456',
        email: 'john@example.com',
      } as any);
    });

    it('should return empty object when not authenticated', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null);
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const context = await getUserContext();

      // Assert
      expect(context).toEqual({});
    });

    it('should handle auth errors gracefully without throwing', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth failed'));
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act & Assert: Should not throw
      const context = await getUserContext();
      expect(context).toEqual({});
    });

    it('should call getSession with headers', async () => {
      // Arrange
      const mockHeaders = createMockHeaders();
      vi.mocked(headers).mockResolvedValue(mockHeaders as any);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      await getUserContext();

      // Assert
      expect(auth.api.getSession).toHaveBeenCalledWith({
        headers: mockHeaders,
      } as any);
    });

    it('should return empty object if session is null', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null);
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const context = await getUserContext();

      // Assert
      expect(context).toEqual({});
      expect(context.userId).toBeUndefined();
      expect(context.sessionId).toBeUndefined();
      expect(context.email).toBeUndefined();
    });
  });

  describe('getFullContext()', () => {
    it('should combine request and user context', async () => {
      // Arrange
      const mockRequest = {
        method: 'POST',
        url: 'http://localhost:3000/api/posts',
      } as Request;

      const mockSession = {
        user: {
          id: 'user-123',
          email: 'john@example.com',
        },
        session: {
          id: 'session-456',
        },
      };

      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({
          'x-request-id': 'req-789',
          'user-agent': 'Chrome',
        }) as any
      );

      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as any);

      // Act
      const context = await getFullContext(mockRequest);

      // Assert
      expect(context).toEqual({
        requestId: 'req-789',
        method: 'POST',
        url: 'http://localhost:3000/api/posts',
        userAgent: 'Chrome',
        userId: 'user-123',
        sessionId: 'session-456',
        email: 'john@example.com',
      } as any);
    });

    it('should work when not authenticated', async () => {
      // Arrange
      const mockRequest = {
        method: 'GET',
        url: 'http://localhost:3000/api/public',
      } as Request;

      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-request-id': 'req-999' }).get,
      } as any);

      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      const context = await getFullContext(mockRequest);

      // Assert
      expect(context.requestId).toBe('req-999');
      expect(context.method).toBe('GET');
      expect(context.userId).toBeUndefined();
      expect(context.sessionId).toBeUndefined();
      expect(context.email).toBeUndefined();
    });

    it('should work without request object', async () => {
      // Arrange
      const mockSession = {
        user: {
          id: 'user-555',
          email: 'jane@example.com',
        },
        session: {
          id: 'session-777',
        },
      };

      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as any);

      // Act
      const context = await getFullContext();

      // Assert
      expect(context.requestId).toBeDefined();
      expect(context.userId).toBe('user-555');
      expect(context.sessionId).toBe('session-777');
      expect(context.email).toBe('jane@example.com');
    });

    it('should call both getRequestContext and getUserContext in parallel', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      await getFullContext();

      // Assert: Both functions should be called
      expect(headers).toHaveBeenCalled();
      expect(auth.api.getSession).toHaveBeenCalled();
    });
  });

  describe('getEndpointPath()', () => {
    it('should extract pathname from request URL', () => {
      // Arrange
      const mockRequest = {
        url: 'http://localhost:3000/api/v1/users?page=1&limit=10',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('/api/v1/users');
    });

    it('should return path without query parameters', () => {
      // Arrange
      const mockRequest = {
        url: 'http://localhost:3000/api/posts?sort=date',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('/api/posts');
    });

    it('should handle URLs without query parameters', () => {
      // Arrange
      const mockRequest = {
        url: 'http://localhost:3000/api/health',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('/api/health');
    });

    it('should handle root path', () => {
      // Arrange
      const mockRequest = {
        url: 'http://localhost:3000/',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('/');
    });

    it('should fallback to full URL on invalid URL', () => {
      // Arrange
      const mockRequest = {
        url: 'not-a-valid-url',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('not-a-valid-url');
    });

    it('should handle nested paths', () => {
      // Arrange
      const mockRequest = {
        url: 'http://localhost:3000/api/v1/users/123/posts?filter=active',
      } as Request;

      // Act
      const path = getEndpointPath(mockRequest);

      // Assert
      expect(path).toBe('/api/v1/users/123/posts');
    });
  });

  describe('getClientIp()', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-forwarded-for': '1.2.3.4' }).get,
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('1.2.3.4');
    });

    it('should extract first IP from x-forwarded-for with multiple IPs', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' }) as any
      );

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('1.2.3.4'); // First IP only
    });

    it('should trim whitespace from extracted IP', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({ 'x-forwarded-for': '  1.2.3.4  , 5.6.7.8' }) as any
      );

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('1.2.3.4'); // Trimmed
    });

    it('should extract IP from x-real-ip header', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-real-ip': '2.3.4.5' }).get,
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('2.3.4.5');
    });

    it('should extract IP from cf-connecting-ip header (Cloudflare)', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'cf-connecting-ip': '3.4.5.6' }).get,
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('3.4.5.6');
    });

    it('should extract IP from x-client-ip header', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-client-ip': '4.5.6.7' }).get,
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('4.5.6.7');
    });

    it('should extract IP from x-cluster-client-ip header', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue({
        get: createMockHeaders({ 'x-cluster-client-ip': '5.6.7.8' }).get,
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('5.6.7.8');
    });

    it('should return undefined if no IP headers present', async () => {
      // Arrange
      vi.mocked(headers).mockResolvedValue(createMockHeaders() as any);

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBeUndefined();
    });

    it('should prioritize headers in correct order', async () => {
      // Arrange: x-forwarded-for should be checked first
      vi.mocked(headers).mockResolvedValue({
        get: vi.fn((header: string) => {
          const headerMap: Record<string, string> = {
            'x-forwarded-for': '1.1.1.1',
            'x-real-ip': '2.2.2.2',
            'cf-connecting-ip': '3.3.3.3',
          };
          return headerMap[header] || null;
        }),
      } as any);

      // Act
      const ip = await getClientIp();

      // Assert: Should use x-forwarded-for first
      expect(ip).toBe('1.1.1.1');
    });

    it('should use second priority header if first is missing', async () => {
      // Arrange: x-real-ip should be used if x-forwarded-for is missing
      vi.mocked(headers).mockResolvedValue(
        createMockHeaders({
          'x-real-ip': '2.2.2.2',
          'cf-connecting-ip': '3.3.3.3',
        }) as any
      );

      // Act
      const ip = await getClientIp();

      // Assert
      expect(ip).toBe('2.2.2.2');
    });
  });
});
