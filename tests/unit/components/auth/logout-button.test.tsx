/**
 * LogoutButton Component Tests
 *
 * Tests the LogoutButton component which handles:
 * - Rendering logout button with different variants
 * - User sign-out with loading state
 * - Analytics tracking (USER_LOGGED_OUT event + reset)
 * - Router navigation and refresh
 * - Error handling during logout
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/auth/logout-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogoutButton } from '@/components/auth/logout-button';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signOut: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn(),
    reset: vi.fn(),
  })),
  EVENTS: {
    USER_LOGGED_OUT: 'user_logged_out',
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Test Suite: LogoutButton Component
 */
describe('components/auth/logout-button', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };
  let mockAnalytics: { track: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = {
      push: vi.fn(),
      refresh: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue({
      ...mockRouter,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Setup mock analytics
    const { useAnalytics } = await import('@/lib/analytics');
    mockAnalytics = {
      track: vi.fn().mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>,
      reset: vi.fn().mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>,
    };
    vi.mocked(useAnalytics).mockReturnValue({
      ...mockAnalytics,
      identify: vi.fn(),
      page: vi.fn(),
      isReady: true,
      isEnabled: true,
    } as unknown as ReturnType<typeof useAnalytics>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render logout button with default text', () => {
      // Arrange & Act
      render(<LogoutButton />);

      // Assert
      const button = screen.getByRole('button', { name: /sign out/i });
      expect(button).toBeInTheDocument();
    });

    it('should render with ghost variant by default', () => {
      // Arrange & Act
      render(<LogoutButton />);

      // Assert - Ghost variant has hover:bg-accent
      const button = screen.getByRole('button', { name: /sign out/i });
      expect(button.className).toContain('hover:bg-accent');
    });

    it('should render with custom variant', () => {
      // Arrange & Act
      render(<LogoutButton variant="destructive" />);

      // Assert - Destructive variant has bg-destructive
      const button = screen.getByRole('button', { name: /sign out/i });
      expect(button.className).toContain('bg-destructive');
    });

    it('should render with custom size', () => {
      // Arrange & Act
      render(<LogoutButton size="sm" />);

      // Assert - Small size has h-8
      const button = screen.getByRole('button', { name: /sign out/i });
      expect(button.className).toContain('h-8');
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(<LogoutButton className="custom-class" />);

      // Assert
      const button = screen.getByRole('button', { name: /sign out/i });
      expect(button.className).toContain('custom-class');
    });
  });

  describe('logout flow', () => {
    it('should track USER_LOGGED_OUT event before signing out', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        // Call onSuccess callback
        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Track should be called with USER_LOGGED_OUT event
      await waitFor(() => {
        expect(mockAnalytics.track).toHaveBeenCalledWith('user_logged_out');
      });
    });

    it('should call authClient.signOut after tracking', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(authClient.signOut).toHaveBeenCalled();
      });
    });

    it('should call analytics.reset() after successful logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Reset should be called to clear analytics identity
      await waitFor(() => {
        expect(mockAnalytics.reset).toHaveBeenCalled();
      });
    });

    it('should redirect to default path after logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
        expect(mockRouter.refresh).toHaveBeenCalled();
      });
    });

    it('should redirect to custom path after logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      render(<LogoutButton redirectTo="/login" />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/login');
      });
    });

    it('should show loading state during logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      // Make signOut hang to keep loading state
      vi.mocked(authClient.signOut).mockImplementation(() => new Promise(() => {}) as never);

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /signing out/i })).toBeInTheDocument();
      });
    });

    it('should disable button during logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(() => new Promise(() => {}) as never);

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /signing out/i })).toBeDisabled();
      });
    });
  });

  describe('error handling', () => {
    it('should handle signOut error gracefully', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');
      const { logger } = await import('@/lib/logging');

      const mockError = Object.assign(new Error('Network error'), {
        status: 500,
        statusText: 'Internal Server Error',
        error: 'Network error',
      });

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onError?.({
          error: mockError,
          response: {} as never,
          request: {} as never,
        } as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Error should be logged
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith('Logout failed', mockError);
      });
    });

    it('should re-enable button after error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onError?.({
          error: Object.assign(new Error('Network error'), {
            status: 500,
            statusText: 'Error',
            error: 'Network error',
          }),
        } as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Button should be re-enabled after error
      await waitFor(() => {
        const buttonAfterError = screen.getByRole('button', { name: /sign out/i });
        expect(buttonAfterError).not.toBeDisabled();
      });
    });

    it('should handle catch block errors', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(authClient.signOut).mockRejectedValue(new Error('Unexpected error'));

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalled();
      });
    });

    it('should not call reset() if signOut fails', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onError?.({
          error: Object.assign(new Error('Failed'), {
            status: 500,
            statusText: 'Error',
            error: 'Failed',
          }),
          response: {} as never,
          request: {} as never,
        } as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Reset should NOT be called if signOut failed
      await waitFor(() => {
        expect(mockAnalytics.reset).not.toHaveBeenCalled();
      });
    });

    it('should not redirect if signOut fails', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        await options?.fetchOptions?.onError?.({
          error: Object.assign(new Error('Failed'), {
            status: 500,
            statusText: 'Error',
            error: 'Failed',
          }),
          response: {} as never,
          request: {} as never,
        } as never);
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Router should NOT be called if signOut failed
      await waitFor(() => {
        expect(mockRouter.push).not.toHaveBeenCalled();
        expect(mockRouter.refresh).not.toHaveBeenCalled();
      });
    });
  });

  describe('analytics integration', () => {
    it('should track event before calling signOut', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');
      const callOrder: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      mockAnalytics.track.mockImplementation(() => {
        callOrder.push('track');
        return Promise.resolve();
      });

      vi.mocked(authClient.signOut).mockImplementation(async () => {
        callOrder.push('signOut');
        return undefined as never;
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Track should be called before signOut
      await waitFor(() => {
        expect(callOrder).toEqual(['track', 'signOut']);
      });
    });

    it('should reset analytics identity after successful logout', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');
      const callOrder: string[] = [];

      vi.mocked(authClient.signOut).mockImplementation(async (options) => {
        callOrder.push('signOut');

        await options?.fetchOptions?.onSuccess?.(undefined as never);
        return undefined as never;
      });

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      mockAnalytics.reset.mockImplementation(() => {
        callOrder.push('reset');
        return Promise.resolve();
      });

      render(<LogoutButton />);

      const button = screen.getByRole('button', { name: /sign out/i });

      // Act
      await user.click(button);

      // Assert - Reset should be called in onSuccess callback
      await waitFor(() => {
        expect(callOrder).toContain('reset');
        expect(callOrder.indexOf('signOut')).toBeLessThan(callOrder.indexOf('reset'));
      });
    });
  });
});
