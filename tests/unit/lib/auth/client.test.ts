/**
 * Auth Client Tests
 *
 * Tests the authClient initialization and configuration:
 * - Creates auth client with correct baseURL from NEXT_PUBLIC_APP_URL
 * - Falls back to localhost when env var is not set
 * - Exports expected methods (signIn, signUp, signOut)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-auth/react
const mockCreateAuthClient = vi.fn();
vi.mock('better-auth/react', () => ({
  createAuthClient: mockCreateAuthClient,
}));

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
      useSession: vi.fn(),
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

  describe('useSession hook', () => {
    it('should export useSession from authClient', async () => {
      // Act
      const { useSession } = await import('@/lib/auth/client');

      // Assert
      expect(useSession).toBeDefined();
      expect(typeof useSession).toBe('function');
    });
  });
});
