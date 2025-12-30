/**
 * Authentication Utility Tests
 *
 * Week 3, Task 7: Comprehensive tests for authentication utility functions.
 *
 * Test Coverage:
 * - getServerSession() - Get current user session from better-auth
 * - getServerUser() - Extract user from session
 * - hasRole() - Check if user has required role
 * - requireAuth() - Enforce authentication (throws if not authenticated)
 * - requireRole() - Enforce role-based access (throws if wrong role)
 * - isAuthenticated() - Type guard for session
 *
 * @see lib/auth/utils.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getServerSession,
  getServerUser,
  hasRole,
  requireAuth,
  requireRole,
  isAuthenticated,
} from '@/lib/auth/utils';

/**
 * Mock dependencies
 */

// Mock better-auth config
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock the logger to verify error logging
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

// Import mocked modules
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';
import { logger } from '@/lib/logging';

/**
 * Test data factories
 */

const createMockHeaders = () => {
  return new Headers({
    'user-agent': 'test-agent',
    'x-forwarded-for': '127.0.0.1',
  });
};

const createMockSession = (role: string | null = 'USER') => ({
  session: {
    id: 'session-123',
    userId: 'user-123',
    token: 'token-abc',
    expiresAt: new Date('2025-12-31'),
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
  user: {
    id: 'user-123',
    name: 'John Doe',
    email: 'john@example.com',
    emailVerified: true,
    image: 'https://example.com/avatar.jpg',
    role: role,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
});

/**
 * Test Suite: getServerSession()
 *
 * Tests the core function for retrieving the current user session from better-auth
 */
describe('getServerSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful session retrieval', () => {
    it('should return session when user is authenticated', async () => {
      // Arrange: Mock successful session retrieval
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Get the session
      const result = await getServerSession();

      // Assert: Verify session returned correctly
      expect(result).toEqual(mockSession);
      expect(headers).toHaveBeenCalledTimes(1);
      expect(auth.api.getSession).toHaveBeenCalledWith({ headers: mockHeaders });
    });

    it('should return session with null role', async () => {
      // Arrange: Mock session with null role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession(null);

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await getServerSession();

      // Assert: Verify session with null role is handled
      expect(result).toEqual(mockSession);
      expect(result?.user.role).toBeNull();
    });

    it('should return session with ADMIN role', async () => {
      // Arrange: Mock session with admin user
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await getServerSession();

      // Assert: Verify admin role preserved
      expect(result?.user.role).toBe('ADMIN');
    });
  });

  describe('unauthenticated user', () => {
    it('should return null when no session exists', async () => {
      // Arrange: Mock no session (better-auth returns null)
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      const result = await getServerSession();

      // Assert: Verify null returned
      expect(result).toBeNull();
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return null and log error when getSession throws', async () => {
      // Arrange: Mock getSession to throw error
      const mockHeaders = createMockHeaders();
      const error = new Error('Session retrieval failed');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(error);

      // Act
      const result = await getServerSession();

      // Assert: Verify error handled gracefully
      expect(result).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Failed to get server session', error);
    });

    it('should return null and log error when headers() throws', async () => {
      // Arrange: Mock headers to throw error
      const error = new Error('Headers unavailable');

      vi.mocked(headers).mockRejectedValue(error);

      // Act
      const result = await getServerSession();

      // Assert: Verify error handled
      expect(result).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Failed to get server session', error);
    });

    it('should handle network errors gracefully', async () => {
      // Arrange: Mock network error
      const mockHeaders = createMockHeaders();
      const networkError = new Error('ECONNREFUSED');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(networkError);

      // Act
      const result = await getServerSession();

      // Assert
      expect(result).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to get server session',
        networkError
      );
    });
  });
});

/**
 * Test Suite: getServerUser()
 *
 * Tests the convenience function for extracting just the user from a session
 */
describe('getServerUser()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with authenticated session', () => {
    it('should return user when session exists', async () => {
      // Arrange: Mock session with user
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Get user
      const result = await getServerUser();

      // Assert: Verify user object returned
      expect(result).toEqual(mockSession.user);
      expect(result).toHaveProperty('id', 'user-123');
      expect(result).toHaveProperty('name', 'John Doe');
      expect(result).toHaveProperty('email', 'john@example.com');
    });

    it('should return user with all properties', async () => {
      // Arrange
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('MODERATOR');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await getServerUser();

      // Assert: Verify all user properties present
      expect(result).toMatchObject({
        id: 'user-123',
        name: 'John Doe',
        email: 'john@example.com',
        emailVerified: true,
        image: 'https://example.com/avatar.jpg',
        role: 'MODERATOR',
      });
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('without authenticated session', () => {
    it('should return null when session is null', async () => {
      // Arrange: Mock no session
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      const result = await getServerUser();

      // Assert: Verify null returned
      expect(result).toBeNull();
    });

    it('should return null when getSession throws error', async () => {
      // Arrange: Mock error in session retrieval
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth error'));

      // Act
      const result = await getServerUser();

      // Assert: Verify null returned due to error
      expect(result).toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });
  });
});

/**
 * Test Suite: hasRole()
 *
 * Tests the role-checking function that returns a boolean
 */
describe('hasRole()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with authenticated user', () => {
    it('should return true when user has the required role', async () => {
      // Arrange: Mock user with ADMIN role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Check for ADMIN role
      const result = await hasRole('ADMIN');

      // Assert: Verify true returned
      expect(result).toBe(true);
    });

    it('should return false when user has different role', async () => {
      // Arrange: Mock user with USER role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('USER');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Check for ADMIN role (user only has USER)
      const result = await hasRole('ADMIN');

      // Assert: Verify false returned
      expect(result).toBe(false);
    });

    it('should return false when user role is null', async () => {
      // Arrange: Mock user with null role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession(null);

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Check for any role
      const result = await hasRole('USER');

      // Assert: Verify false returned (null !== 'USER')
      expect(result).toBe(false);
    });

    it('should handle MODERATOR role correctly', async () => {
      // Arrange: Mock user with MODERATOR role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('MODERATOR');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await hasRole('MODERATOR');

      // Assert
      expect(result).toBe(true);
    });

    it('should be case-sensitive for role matching', async () => {
      // Arrange: Mock user with 'ADMIN' role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Check with lowercase 'admin'
      const result = await hasRole('admin');

      // Assert: Verify false (case mismatch)
      expect(result).toBe(false);
    });
  });

  describe('without authenticated user', () => {
    it('should return false when no session exists', async () => {
      // Arrange: Mock no session
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act: Check for any role
      const result = await hasRole('ADMIN');

      // Assert: Verify false (unauthenticated)
      expect(result).toBe(false);
    });

    it('should return false when session retrieval fails', async () => {
      // Arrange: Mock error
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth error'));

      // Act
      const result = await hasRole('ADMIN');

      // Assert: Verify false (error = no user)
      expect(result).toBe(false);
    });
  });
});

/**
 * Test Suite: requireAuth()
 *
 * Tests the authentication enforcement function that throws if not authenticated
 */
describe('requireAuth()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with authenticated user', () => {
    it('should return session when user is authenticated', async () => {
      // Arrange: Mock authenticated session
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Require authentication
      const result = await requireAuth();

      // Assert: Verify session returned (no throw)
      expect(result).toEqual(mockSession);
      expect(result.user.id).toBe('user-123');
    });

    it('should return session with any role', async () => {
      // Arrange: Mock ADMIN user
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await requireAuth();

      // Assert: Verify session returned regardless of role
      expect(result).toEqual(mockSession);
      expect(result.user.role).toBe('ADMIN');
    });

    it('should return session even with null role', async () => {
      // Arrange: Mock user with null role (still authenticated)
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession(null);

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await requireAuth();

      // Assert: Verify authentication succeeds (role check is separate)
      expect(result).toEqual(mockSession);
      expect(result.user.role).toBeNull();
    });
  });

  describe('without authenticated user', () => {
    it('should throw error when session is null', async () => {
      // Arrange: Mock no session
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act & Assert: Verify error thrown
      await expect(requireAuth()).rejects.toThrow('Authentication required');
    });

    it('should throw error when session retrieval fails', async () => {
      // Arrange: Mock error in getSession
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth error'));

      // Act & Assert: Verify error propagated as "Authentication required"
      await expect(requireAuth()).rejects.toThrow('Authentication required');
    });
  });
});

/**
 * Test Suite: requireRole()
 *
 * Tests the role enforcement function that throws if user doesn't have required role
 */
describe('requireRole()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with authenticated user and correct role', () => {
    it('should return session when user has required role', async () => {
      // Arrange: Mock ADMIN user
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act: Require ADMIN role
      const result = await requireRole('ADMIN');

      // Assert: Verify session returned
      expect(result).toEqual(mockSession);
      expect(result.user.role).toBe('ADMIN');
    });

    it('should return session for USER role', async () => {
      // Arrange: Mock USER
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('USER');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await requireRole('USER');

      // Assert
      expect(result).toEqual(mockSession);
      expect(result.user.role).toBe('USER');
    });

    it('should return session for MODERATOR role', async () => {
      // Arrange: Mock MODERATOR
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('MODERATOR');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act
      const result = await requireRole('MODERATOR');

      // Assert
      expect(result).toEqual(mockSession);
      expect(result.user.role).toBe('MODERATOR');
    });
  });

  describe('with authenticated user but wrong role', () => {
    it('should throw error when user has different role', async () => {
      // Arrange: Mock USER trying to access ADMIN resource
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('USER');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act & Assert: Verify role error thrown
      await expect(requireRole('ADMIN')).rejects.toThrow('Role ADMIN required');
    });

    it('should throw error when user role is null', async () => {
      // Arrange: Mock user with null role
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession(null);

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act & Assert
      await expect(requireRole('USER')).rejects.toThrow('Role USER required');
    });

    it('should throw error with specific role in message', async () => {
      // Arrange: Mock MODERATOR trying to access ADMIN
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('MODERATOR');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act & Assert: Verify error message includes required role
      await expect(requireRole('ADMIN')).rejects.toThrow('Role ADMIN required');
    });

    it('should be case-sensitive for role matching', async () => {
      // Arrange: Mock 'ADMIN' user
      const mockHeaders = createMockHeaders();
      const mockSession = createMockSession('ADMIN');

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

      // Act & Assert: Verify lowercase 'admin' fails
      await expect(requireRole('admin')).rejects.toThrow('Role admin required');
    });
  });

  describe('without authenticated user', () => {
    it('should throw authentication error when no session exists', async () => {
      // Arrange: Mock no session
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act & Assert: Verify authentication error (before role check)
      await expect(requireRole('ADMIN')).rejects.toThrow('Authentication required');
    });

    it('should throw authentication error when session retrieval fails', async () => {
      // Arrange: Mock error
      const mockHeaders = createMockHeaders();

      vi.mocked(headers).mockResolvedValue(mockHeaders);
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth error'));

      // Act & Assert
      await expect(requireRole('ADMIN')).rejects.toThrow('Authentication required');
    });
  });
});

/**
 * Test Suite: isAuthenticated()
 *
 * Tests the TypeScript type guard for session validation
 */
describe('isAuthenticated()', () => {
  describe('type guard behavior', () => {
    it('should return true for valid session object', () => {
      // Arrange: Create valid session
      const session = createMockSession();

      // Act: Check if authenticated
      const result = isAuthenticated(session);

      // Assert: Verify true returned
      expect(result).toBe(true);
    });

    it('should return false for null session', () => {
      // Arrange: Null session
      const session = null;

      // Act
      const result = isAuthenticated(session);

      // Assert: Verify false returned
      expect(result).toBe(false);
    });

    it('should narrow type to AuthSession when true', () => {
      // Arrange
      const session = createMockSession();

      // Act: Type guard in conditional
      if (isAuthenticated(session)) {
        // Assert: TypeScript knows session is not null here
        expect(session.user.email).toBe('john@example.com');
        expect(session.session.id).toBe('session-123');
      } else {
        // This branch should not execute
        expect.fail('Type guard should return true for valid session');
      }
    });

    it('should work with session of any role', () => {
      // Arrange: Test different roles
      const adminSession = createMockSession('ADMIN');
      const userSession = createMockSession('USER');
      const nullRoleSession = createMockSession(null);

      // Act & Assert: All should be authenticated
      expect(isAuthenticated(adminSession)).toBe(true);
      expect(isAuthenticated(userSession)).toBe(true);
      expect(isAuthenticated(nullRoleSession)).toBe(true);
    });

    it('should enable type-safe access after check', () => {
      // Arrange: Session that might be null
      const maybeSession: ReturnType<typeof createMockSession> | null = createMockSession();

      // Act & Assert: Type guard enables safe access
      if (isAuthenticated(maybeSession)) {
        // TypeScript knows maybeSession is not null
        expect(maybeSession.user).toBeDefined();
        expect(maybeSession.session).toBeDefined();
        expect(typeof maybeSession.user.email).toBe('string');
      }
    });

    it('should prevent access when false', () => {
      // Arrange
      const maybeSession: ReturnType<typeof createMockSession> | null = null;

      // Act & Assert: Type guard prevents access
      if (isAuthenticated(maybeSession)) {
        expect.fail('Should not reach this branch for null session');
      } else {
        // TypeScript knows maybeSession is null here
        expect(maybeSession).toBeNull();
      }
    });
  });
});
