/**
 * Unit Tests: Auth Guards (withAuth, withAdminAuth)
 *
 * Tests higher-order functions that wrap API route handlers with authentication
 * and authorization checks. These guards eliminate duplicated session/role
 * boilerplate across route handlers.
 *
 * Test Coverage:
 * - withAuth: Authentication verification, handler invocation, error handling
 * - withAdminAuth: Authentication + admin role verification, error handling
 * - Route handlers with and without dynamic params
 * - Error propagation through handleAPIError
 * - Response forwarding from handlers
 *
 * Key Behaviors:
 * - Returns 401 (UNAUTHORIZED) when session is null
 * - Returns 403 (FORBIDDEN) when user lacks admin role (withAdminAuth only)
 * - Passes authenticated session to handler
 * - Correctly handles route params context (TParams generic)
 * - Wraps handler errors with handleAPIError
 * - Returns the Response from handler on success
 *
 * @see lib/auth/guards.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { withAuth, withAdminAuth, type AuthSession } from '@/lib/auth/guards';
import { UnauthorizedError, ForbiddenError } from '@/lib/api/errors';

/**
 * Mock dependencies
 */

// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock auth config
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Import mocked modules
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';

/**
 * Test helpers
 */

/** Dummy request for handler invocation (auth is mocked via headers) */
const createRequest = (url = 'http://localhost:3000/api/test'): NextRequest => {
  return new NextRequest(url);
};

/**
 * Create mock session matching AuthSession interface
 */
function createMockSession(role: 'USER' | 'ADMIN' | null = 'USER'): AuthSession {
  return {
    session: {
      id: 'session_test123',
      userId: 'user_test123',
      token: 'mock_token',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 'user_test123',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role: role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

/**
 * Parse JSON response helper
 */
async function parseResponse<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Response type interfaces
 */
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
}

/**
 * Test Suite: withAuth
 */
describe('withAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  describe('Authentication Checks', () => {
    it('should return 401 when auth.api.getSession returns null', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'test' });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Unauthorized');

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });

    it('should pass authenticated session to handler when session exists', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        return Response.json({ success: true, data: { userId: session.user.id } });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ userId: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.userId).toBe(mockSession.user.id);

      // Handler should be called with request and session
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession);
    });

    it('should work with USER role', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        return Response.json({ success: true, data: { role: session.user.role } });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ role: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.role).toBe('USER');
    });

    it('should work with ADMIN role', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        return Response.json({ success: true, data: { role: session.user.role } });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ role: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.role).toBe('ADMIN');
    });
  });

  describe('Handler Invocation', () => {
    it('should receive (request, session) arguments correctly', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        // Verify arguments are correct types
        expect(_request).toBeInstanceOf(NextRequest);
        expect(session).toHaveProperty('user');
        expect(session).toHaveProperty('session');
        return Response.json({ success: true, data: 'ok' });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      await wrappedHandler(request);

      // Assert
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession);
    });

    it('should receive (request, session, context) when route has params', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(
        async (
          _request: NextRequest,
          _session: AuthSession,
          context: { params: Promise<{ id: string }> }
        ) => {
          const params = await context.params;
          return Response.json({ success: true, data: { id: params.id } });
        }
      );

      const wrappedHandler = withAuth<{ id: string }>(handler);
      const request = createRequest();
      const context = { params: Promise.resolve({ id: 'test-123' }) };

      // Act
      const response = await wrappedHandler(request, context);
      const data = await parseResponse<SuccessResponse<{ id: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.id).toBe('test-123');

      // Handler should be called with request, session, and context
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession, context);
    });

    it('should handle complex route params', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      type RouteParams = { userId: string; postId: string };

      const handler = vi.fn(
        async (
          _request: NextRequest,
          _session: AuthSession,
          context: { params: Promise<RouteParams> }
        ) => {
          const params = await context.params;
          return Response.json({
            success: true,
            data: { userId: params.userId, postId: params.postId },
          });
        }
      );

      const wrappedHandler = withAuth<RouteParams>(handler);
      const request = createRequest();
      const context = { params: Promise.resolve({ userId: 'user-1', postId: 'post-2' }) };

      // Act
      const response = await wrappedHandler(request, context);
      const data = await parseResponse<SuccessResponse<RouteParams>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.userId).toBe('user-1');
      expect(data.data.postId).toBe('post-2');
    });

    it('should return the Response from the handler on success', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const expectedResponse = Response.json(
        { success: true, data: { message: 'custom response' } },
        { status: 201, headers: { 'X-Custom': 'header' } }
      );

      const handler = vi.fn(async () => expectedResponse);

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);

      // Assert
      expect(response.status).toBe(201);
      expect(response.headers.get('X-Custom')).toBe('header');

      const data = await parseResponse<SuccessResponse<{ message: string }>>(response);
      expect(data.data.message).toBe('custom response');
    });
  });

  describe('Error Handling', () => {
    it('should wrap handler errors with handleAPIError', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const testError = new Error('Handler crashed');
      const handler = vi.fn(async () => {
        throw testError;
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert - handleAPIError should return 500 for unknown errors
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
      expect(data.error.message).toBe('Handler crashed');
    });

    it('should handle UnauthorizedError thrown by handler', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        throw new UnauthorizedError('Custom auth error');
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Custom auth error');
    });

    it('should handle ForbiddenError thrown by handler', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        throw new ForbiddenError('Custom forbidden error');
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Custom forbidden error');
    });

    it('should handle session fetch errors', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Session service down'));

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'test' });
      });

      const wrappedHandler = withAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.message).toBe('Session service down');

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

/**
 * Test Suite: withAdminAuth
 */
describe('withAdminAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock headers
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  describe('Authentication Checks', () => {
    it('should return 401 when auth.api.getSession returns null', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockResolvedValue(null as never);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Unauthorized');

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Authorization Checks', () => {
    it('should return 403 with "Admin access required" when user role is not ADMIN', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });

    it('should return 403 for role USER', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');
    });

    it('should return 403 when user role is null', async () => {
      // Arrange
      const mockSession = createMockSession(null);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Admin access required');
    });

    it('should pass authenticated admin session to handler', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        return Response.json({ success: true, data: { userId: session.user.id } });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ userId: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.userId).toBe(mockSession.user.id);

      // Handler should be called with request and session
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession);
    });
  });

  describe('Handler Invocation', () => {
    it('should receive (request, session) arguments correctly', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        // Verify arguments are correct types
        expect(_request).toBeInstanceOf(NextRequest);
        expect(session).toHaveProperty('user');
        expect(session).toHaveProperty('session');
        expect(session.user.role).toBe('ADMIN');
        return Response.json({ success: true, data: 'ok' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      await wrappedHandler(request);

      // Assert
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession);
    });

    it('should receive (request, session, context) when route has params', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(
        async (
          _request: NextRequest,
          _session: AuthSession,
          context: { params: Promise<{ id: string }> }
        ) => {
          const params = await context.params;
          return Response.json({ success: true, data: { id: params.id } });
        }
      );

      const wrappedHandler = withAdminAuth<{ id: string }>(handler);
      const request = createRequest();
      const context = { params: Promise.resolve({ id: 'admin-123' }) };

      // Act
      const response = await wrappedHandler(request, context);
      const data = await parseResponse<SuccessResponse<{ id: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.id).toBe('admin-123');

      // Handler should be called with request, session, and context
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, mockSession, context);
    });

    it('should return the Response from the handler on success', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const expectedResponse = Response.json(
        { success: true, data: { stats: 'admin stats' } },
        { status: 200, headers: { 'X-Admin': 'true' } }
      );

      const handler = vi.fn(async () => expectedResponse);

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Admin')).toBe('true');

      const data = await parseResponse<SuccessResponse<{ stats: string }>>(response);
      expect(data.data.stats).toBe('admin stats');
    });
  });

  describe('Error Handling', () => {
    it('should wrap handler errors with handleAPIError', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const testError = new Error('Admin handler crashed');
      const handler = vi.fn(async () => {
        throw testError;
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert - handleAPIError should return 500 for unknown errors
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
      expect(data.error.message).toBe('Admin handler crashed');
    });

    it('should handle UnauthorizedError thrown by handler', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        throw new UnauthorizedError('Session expired');
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
      expect(data.error.message).toBe('Session expired');
    });

    it('should handle ForbiddenError thrown by handler', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async () => {
        throw new ForbiddenError('Insufficient permissions');
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
      expect(data.error.message).toBe('Insufficient permissions');
    });

    it('should handle session fetch errors', async () => {
      // Arrange
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth service unavailable'));

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<ErrorResponse>(response);

      // Assert
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.message).toBe('Auth service unavailable');

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle async params context', async () => {
      // Arrange
      const mockSession = createMockSession('ADMIN');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(
        async (
          _request: NextRequest,
          _session: AuthSession,
          context: { params: Promise<{ id: string }> }
        ) => {
          // Simulate async params processing
          const params = await context.params;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return Response.json({ success: true, data: { id: params.id } });
        }
      );

      const wrappedHandler = withAdminAuth<{ id: string }>(handler);
      const request = createRequest();
      const context = { params: Promise.resolve({ id: 'async-123' }) };

      // Act
      const response = await wrappedHandler(request, context);
      const data = await parseResponse<SuccessResponse<{ id: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(data.data.id).toBe('async-123');
    });
  });
});
