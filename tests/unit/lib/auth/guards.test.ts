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
 * Most fixtures in this file wrap a stub handler to test *authentication*, and a
 * bare `withAuth(handler)` is now a violation for a member session: the default
 * policy narrows a non-admin to their own rows, and a route that never says how
 * it decides whose rows it reads is what `RouteOwnership` exists to catch. So
 * these say it — and saying "this test is not about ownership" out loud is more
 * honest than an admin session quietly sidestepping the check.
 */
const NOT_ABOUT_OWNERSHIP = {
  ownership: {
    decidedBy: 'nothing',
    because: 'Fixture: this test is about the guard, not about whose rows the route reads.',
  },
} as const;

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

// Mock API-key resolver (Phase 4 fallback). Defaults to null so existing
// cookie-session tests behave exactly as before; api-key tests override
// per-test below.
vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  // `capture` stands in for a scope a fork declared in
  // `lib/app/api-key-scopes.ts`, which is the situation `{ scope }` exists for.
  // The undeclared-scope warning has its own test below.
  listValidApiKeyScopes: vi.fn(() => [
    'chat',
    'analytics',
    'knowledge',
    'webhook',
    'admin',
    'capture',
  ]),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Import mocked modules
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { logger } from '@/lib/logging';

/**
 * Test helpers
 */

/** Dummy request for handler invocation (auth is mocked via headers) */
const createRequest = (url = 'http://localhost:3000/api/test'): NextRequest => {
  return new NextRequest(url);
};

/**
 * Create mock session matching AuthSession interface.
 * Pass `id` to use a non-default user ID (e.g. for multi-user bucket tests).
 */
function createMockSession(
  role: 'USER' | 'ADMIN' | null = 'USER',
  id = 'user_test123'
): AuthSession {
  return {
    session: {
      id: 'session_test123',
      userId: id,
      token: 'mock_token',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id,
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
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'test' });
      });

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ userId: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status 200 and data.userId checks
      expect(data.success).toBe(true);
      expect(data.data.userId).toBe(mockSession.user.id);

      // Handler should be called with request and session
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession));
    });

    it('should work with USER role', async () => {
      // Arrange
      const mockSession = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession as never);

      const handler = vi.fn(async (_request: NextRequest, session: AuthSession) => {
        return Response.json({ success: true, data: { role: session.user.role } });
      });

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
      const request = createRequest();

      // Act
      await wrappedHandler(request);

      // Assert
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession));
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

      const wrappedHandler = withAuth<{ id: string }>(handler, NOT_ABOUT_OWNERSHIP);
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
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession), context);
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

      const wrappedHandler = withAuth<RouteParams>(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAuth(handler, NOT_ABOUT_OWNERSHIP);
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
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const handler = vi.fn(async () => {
        return Response.json({ success: true, data: 'admin data' });
      });

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const request = createRequest();

      // Act
      const response = await wrappedHandler(request);
      const data = await parseResponse<SuccessResponse<{ userId: string }>>(response);

      // Assert
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — structural assertion on the API response envelope's success field, paired with status 200 and data.userId checks
      expect(data.success).toBe(true);
      expect(data.data.userId).toBe(mockSession.user.id);

      // Handler should be called with request and session
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession));
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const request = createRequest();

      // Act
      await wrappedHandler(request);

      // Assert
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession));
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

      const wrappedHandler = withAdminAuth<{ id: string }>(handler, NOT_ABOUT_OWNERSHIP);
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
      expect(handler).toHaveBeenCalledWith(request, expect.objectContaining(mockSession), context);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
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

      const wrappedHandler = withAdminAuth<{ id: string }>(handler, NOT_ABOUT_OWNERSHIP);
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

/**
 * Test Suite: API-key fallback (Phase 4)
 */
describe('API-key fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers());
  });

  function mockApiKey(scopes: string[]): AuthSession {
    const session = createMockSession('USER', 'apikey-owner-id');
    vi.mocked(resolveApiKey).mockResolvedValue({
      session,
      scopes,
      rateLimitRpm: null,
    });
    return session;
  }

  describe('withAuth', () => {
    it('passes the API-key session to the handler without checking the cookie', async () => {
      const session = mockApiKey(['chat']);
      const handler = vi.fn(async () => Response.json({ success: true, data: { ok: true } }));
      const wrapped = withAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(session));
      // The session-cookie path should not have been consulted.
      expect(auth.api.getSession).not.toHaveBeenCalled();
    });

    it('falls back to the cookie path when no API key resolves', async () => {
      vi.mocked(resolveApiKey).mockResolvedValue(null);
      const session = createMockSession('USER');
      vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
      const handler = vi.fn(async () => Response.json({ success: true, data: null }));
      const wrapped = withAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(200);
      expect(auth.api.getSession).toHaveBeenCalledOnce();
    });

    // ---------------------------------------------------------------------
    // `options.scope` — the enforcement half of #542
    // ---------------------------------------------------------------------

    it('403s an API key that lacks the scope the route asked for', async () => {
      mockApiKey(['chat']);
      const handler = vi.fn();
      const wrapped = withAuth(handler, { scope: 'capture', ...NOT_ABOUT_OWNERSHIP });

      const res = await wrapped(createRequest());

      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not name the scopes the key holds in the 403', async () => {
      // A 403 that echoed the key's scopes would be a scope-enumeration oracle
      // for anyone who found the key but not what it is for.
      mockApiKey(['analytics', 'knowledge']);
      const wrapped = withAuth(vi.fn(), { scope: 'capture', ...NOT_ABOUT_OWNERSHIP });

      const body = (await (await wrapped(createRequest())).json()) as {
        error: { message: string };
      };

      expect(body.error.message).toContain('capture');
      expect(body.error.message).not.toContain('analytics');
      expect(body.error.message).not.toContain('knowledge');
    });

    it('admits an API key that holds the scope', async () => {
      const session = mockApiKey(['capture']);
      const handler = vi.fn(async () => Response.json({ success: true, data: { ok: true } }));
      const wrapped = withAuth(handler, { scope: 'capture', ...NOT_ABOUT_OWNERSHIP });

      const res = await wrapped(createRequest());

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(session));
    });

    it('admits an admin-scoped key for any scope, per hasScope', async () => {
      mockApiKey(['admin']);
      const handler = vi.fn(async () => Response.json({ success: true, data: null }));

      const res = await withAuth(handler, { scope: 'capture', ...NOT_ABOUT_OWNERSHIP })(
        createRequest()
      );

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it('does not apply the scope requirement to a cookie session', async () => {
      // Scopes narrow a CREDENTIAL below the user it belongs to. A browser
      // session IS the user, so gating it on a scope would lock a person out
      // of their own page.
      vi.mocked(resolveApiKey).mockResolvedValue(null);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession('USER') as never);
      const handler = vi.fn(async () => Response.json({ success: true, data: null }));

      const res = await withAuth(handler, { scope: 'capture', ...NOT_ABOUT_OWNERSHIP })(
        createRequest()
      );

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it('accepts any scope when the route asks for none — today\u2019s behaviour', async () => {
      // Explicit, because it is the property that makes `{ scope }` opt-in:
      // adding a requirement to a shipped route would revoke access from keys
      // that work today, so no core route sets it yet.
      mockApiKey(['analytics']);
      const handler = vi.fn(async () => Response.json({ success: true, data: null }));

      const res = await withAuth(handler, NOT_ABOUT_OWNERSHIP)(createRequest());

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it('warns at route-definition time for a scope no install declares', async () => {
      // Opening `ApiKeyScope` to accept a fork's name also means a typo
      // type-checks. No key can hold `knowlege`, so the route would 403 every
      // caller forever — and the 403 deliberately says nothing about the key's
      // scopes, so there is nothing to diagnose from outside.
      withAuth(vi.fn(), { scope: 'knowlege' });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no install declares'),
        expect.objectContaining({ scope: 'knowlege' })
      );
    });

    it('does not warn for a declared scope, and never warns without one', async () => {
      withAuth(vi.fn(), { scope: 'capture', ...NOT_ABOUT_OWNERSHIP });
      withAuth(vi.fn(), NOT_ABOUT_OWNERSHIP);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('enforces the scope on a route that also takes params', async () => {
      // The second overload is a separate signature; a scope option that only
      // worked on the no-params one would be an easy thing to ship broken.
      mockApiKey(['chat']);
      const handler = vi.fn();
      const wrapped = withAuth<{ id: string }>(handler, {
        scope: 'capture',
        ...NOT_ABOUT_OWNERSHIP,
      });

      const res = await wrapped(createRequest(), { params: Promise.resolve({ id: 'x' }) });

      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('withAdminAuth', () => {
    it('accepts an API key with admin scope and skips the cookie path', async () => {
      const session = mockApiKey(['admin']);
      const handler = vi.fn(async () => Response.json({ success: true, data: { ok: true } }));
      const wrapped = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(session));
      expect(auth.api.getSession).not.toHaveBeenCalled();
    });

    it("returns 403 for an API key that doesn't include the admin scope", async () => {
      mockApiKey(['chat', 'analytics']);
      const handler = vi.fn();
      const wrapped = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
      // Must not fall through to the cookie path — that would 401 a key-
      // bearing CI caller and confuse the diagnostic.
      expect(auth.api.getSession).not.toHaveBeenCalled();
    });

    it('falls back to cookie-session admin check when no API key is present', async () => {
      vi.mocked(resolveApiKey).mockResolvedValue(null);
      vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession('ADMIN') as never);
      const handler = vi.fn(async () => Response.json({ success: true, data: null }));
      const wrapped = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(200);
      expect(auth.api.getSession).toHaveBeenCalledOnce();
    });

    it('returns 401 when neither an API key nor a session cookie resolves', async () => {
      vi.mocked(resolveApiKey).mockResolvedValue(null);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);
      const handler = vi.fn();
      const wrapped = withAdminAuth(handler, NOT_ABOUT_OWNERSHIP);
      const res = await wrapped(createRequest());
      expect(res.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
