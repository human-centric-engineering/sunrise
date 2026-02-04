/**
 * Auth Client Tests
 *
 * Tests the authClient initialization and configuration:
 * - Creates auth client with correct baseURL from NEXT_PUBLIC_APP_URL
 * - Falls back to localhost when env var is not set
 * - Exports expected methods (signIn, signUp, signOut)
 *
 * Tests the useSession wrapper function:
 * - Role validation (valid roles, missing role, invalid role)
 * - Pass-through behavior when session is null
 * - Error and isPending pass-through
 * - Full session data handling
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-auth/react
const mockUseSession = vi.fn();
const mockCreateAuthClient = vi.fn();
vi.mock('better-auth/react', () => ({
  createAuthClient: mockCreateAuthClient,
}));

/**
 * Test data factories
 */

const createMockSessionData = (role?: string | number | null) => ({
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
    ...(role !== undefined && { role }),
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
});

describe('lib/auth/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();

    // Default mock implementation
    mockCreateAuthClient.mockReturnValue({
      signIn: { email: vi.fn() },
      signUp: { email: vi.fn() },
      signOut: vi.fn(),
      useSession: mockUseSession,
    });
  });

  describe('authClient initialization', () => {
    it('should create auth client with correct baseURL from NEXT_PUBLIC_APP_URL', async () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.com');

      // Act
      await import('@/lib/auth/client');

      // Assert
      expect(mockCreateAuthClient).toHaveBeenCalledWith({
        baseURL: 'https://example.com',
      });
    });

    it('should fall back to localhost when NEXT_PUBLIC_APP_URL is not set', async () => {
      // Arrange
      // Don't set any env var (default behavior)

      // Act
      await import('@/lib/auth/client');

      // Assert
      expect(mockCreateAuthClient).toHaveBeenCalledWith({
        baseURL: 'http://localhost:3000',
      });
    });

    it('should fall back to localhost when NEXT_PUBLIC_APP_URL is empty string', async () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

      // Act
      await import('@/lib/auth/client');

      // Assert
      expect(mockCreateAuthClient).toHaveBeenCalledWith({
        baseURL: 'http://localhost:3000',
      });
    });
  });

  describe('authClient methods', () => {
    it('should have signIn method', async () => {
      // Act
      const { authClient } = await import('@/lib/auth/client');

      // Assert
      expect(authClient).toHaveProperty('signIn');
      expect(authClient.signIn).toBeDefined();
    });

    it('should have signUp method', async () => {
      // Act
      const { authClient } = await import('@/lib/auth/client');

      // Assert
      expect(authClient).toHaveProperty('signUp');
      expect(authClient.signUp).toBeDefined();
    });

    it('should have signOut method', async () => {
      // Act
      const { authClient } = await import('@/lib/auth/client');

      // Assert
      expect(authClient).toHaveProperty('signOut');
      expect(authClient.signOut).toBeDefined();
    });
  });

  describe('useSession hook - basic functionality', () => {
    it('should export useSession function', async () => {
      // Act
      const { useSession } = await import('@/lib/auth/client');

      // Assert
      expect(useSession).toBeDefined();
      expect(typeof useSession).toBe('function');
    });

    it('should return null data when session is null', async () => {
      // Arrange
      mockUseSession.mockReturnValue({
        data: null,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should pass through error when session fetch fails', async () => {
      // Arrange
      const mockError = {
        message: 'Network error',
        status: 500,
        statusText: 'Internal Server Error',
      };
      mockUseSession.mockReturnValue({
        data: null,
        error: mockError,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).toBeNull();
      expect(result.error).toEqual(mockError);
      expect(result.isPending).toBe(false);
    });

    it('should pass through isPending state', async () => {
      // Arrange
      mockUseSession.mockReturnValue({
        data: null,
        error: null,
        isPending: true,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(true);
    });
  });

  describe('useSession hook - role validation', () => {
    it('should preserve valid USER role', async () => {
      // Arrange
      const mockData = createMockSessionData('USER');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should preserve valid ADMIN role', async () => {
      // Arrange
      const mockData = createMockSessionData('ADMIN');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('ADMIN');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is missing', async () => {
      // Arrange
      const mockData = createMockSessionData();
      // Remove role field entirely
      delete (mockData.user as Record<string, unknown>).role;
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is null', async () => {
      // Arrange
      const mockData = createMockSessionData(null);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is undefined', async () => {
      // Arrange
      const mockData = createMockSessionData(undefined);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is empty string', async () => {
      // Arrange
      const mockData = createMockSessionData('');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is an invalid string', async () => {
      // Arrange
      const mockData = createMockSessionData('SUPERUSER');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is a number', async () => {
      // Arrange
      const mockData = createMockSessionData(123);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is an object', async () => {
      // Arrange
      const mockData = createMockSessionData({ value: 'ADMIN' } as never);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is an array', async () => {
      // Arrange
      const mockData = createMockSessionData(['ADMIN'] as never);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should default to USER when role is boolean', async () => {
      // Arrange
      const mockData = createMockSessionData(true as never);
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });
  });

  describe('useSession hook - full session data', () => {
    it('should return complete session data structure with valid role', async () => {
      // Arrange
      const mockData = createMockSessionData('ADMIN');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data).toMatchObject({
        session: {
          id: 'session-123',
          userId: 'user-123',
          token: 'token-abc',
          expiresAt: expect.any(Date),
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
        user: {
          id: 'user-123',
          name: 'John Doe',
          email: 'john@example.com',
          emailVerified: true,
          image: 'https://example.com/avatar.jpg',
          role: 'ADMIN',
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(false);
    });

    it('should preserve all user fields when validating role', async () => {
      // Arrange
      const mockData = createMockSessionData('USER');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.id).toBe('user-123');
      expect(result.data?.user.name).toBe('John Doe');
      expect(result.data?.user.email).toBe('john@example.com');
      expect(result.data?.user.emailVerified).toBe(true);
      expect(result.data?.user.image).toBe('https://example.com/avatar.jpg');
      expect(result.data?.user.role).toBe('USER');
      expect(result.data?.user.createdAt).toEqual(new Date('2025-01-01'));
      expect(result.data?.user.updatedAt).toEqual(new Date('2025-01-01'));
    });

    it('should preserve all session fields', async () => {
      // Arrange
      const mockData = createMockSessionData('USER');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.session.id).toBe('session-123');
      expect(result.data?.session.userId).toBe('user-123');
      expect(result.data?.session.token).toBe('token-abc');
      expect(result.data?.session.expiresAt).toEqual(new Date('2025-12-31'));
      expect(result.data?.session.ipAddress).toBe('127.0.0.1');
      expect(result.data?.session.userAgent).toBe('test-agent');
      expect(result.data?.session.createdAt).toEqual(new Date('2025-01-01'));
      expect(result.data?.session.updatedAt).toEqual(new Date('2025-01-01'));
    });

    it('should handle session with error and data both present', async () => {
      // Arrange
      const mockData = createMockSessionData('USER');
      const mockError = {
        message: 'Partial error',
        status: 200,
        statusText: 'OK',
      };
      mockUseSession.mockReturnValue({
        data: mockData,
        error: mockError,
        isPending: false,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('USER');
      expect(result.error).toEqual(mockError);
      expect(result.isPending).toBe(false);
    });

    it('should handle session with pending state and data', async () => {
      // Arrange
      const mockData = createMockSessionData('ADMIN');
      mockUseSession.mockReturnValue({
        data: mockData,
        error: null,
        isPending: true,
      });

      // Act
      const { useSession } = await import('@/lib/auth/client');
      const result = useSession();

      // Assert
      expect(result.data).not.toBeNull();
      expect(result.data?.user.role).toBe('ADMIN');
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(true);
    });
  });
});
