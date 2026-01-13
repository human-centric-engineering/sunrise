/**
 * OAuthButton Component Tests
 *
 * Tests the single OAuth provider button component.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/oauth-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OAuthButton } from '@/components/forms/oauth-button';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: {
      social: vi.fn(),
    },
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

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: OAuthButton Component
 */
describe('components/forms/oauth-button', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mock behavior
    const { authClient } = await import('@/lib/auth/client');
    vi.mocked(authClient.signIn.social).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render button with children', () => {
      // Arrange & Act
      render(<OAuthButton provider="google">Continue with Google</OAuthButton>);

      // Assert
      expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    });

    it('should have button type="button"', () => {
      // Arrange & Act
      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Assert
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });

    it('should have full width styling', () => {
      // Arrange & Act
      const { container } = render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Assert
      const button = container.querySelector('button');
      expect(button).toHaveClass('w-full');
    });

    it('should not be disabled initially', () => {
      // Arrange & Act
      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Assert
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
  });

  describe('OAuth flow', () => {
    it('should call authClient.signIn.social with provider on click', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'google',
          })
        );
      });
    });

    it('should use callbackUrl prop when provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(
        <OAuthButton provider="google" callbackUrl="/custom">
          Sign in
        </OAuthButton>
      );

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: '/custom',
          })
        );
      });
    });

    it('should use default /dashboard callback when not provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: '/dashboard',
          })
        );
      });
    });

    it('should read callbackUrl from query params when prop not provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('callbackUrl=/profile') as unknown as ReturnType<typeof useSearchParams>
      );

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: '/profile',
          })
        );
      });
    });
  });

  describe('invitation flow', () => {
    it('should pass invitation token and email via additionalData', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(
        <OAuthButton
          provider="google"
          callbackUrl="/dashboard"
          invitationToken="token-123"
          invitationEmail="user@example.com"
        >
          Accept with Google
        </OAuthButton>
      );

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith({
          provider: 'google',
          callbackURL: '/dashboard',
          additionalData: {
            invitationToken: 'token-123',
            invitationEmail: 'user@example.com',
          },
        });
      });
    });

    it('should include errorCallbackUrl when provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(
        <OAuthButton
          provider="google"
          callbackUrl="/dashboard"
          errorCallbackUrl="/accept-invite?error=true"
        >
          Sign in
        </OAuthButton>
      );

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            errorCallbackURL: '/accept-invite?error=true',
          })
        );
      });
    });

    it('should not include invitation data when not provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(
        <OAuthButton provider="google" callbackUrl="/dashboard">
          Sign in
        </OAuthButton>
      );

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith({
          provider: 'google',
          callbackURL: '/dashboard',
        });
      });
    });
  });

  describe('loading state', () => {
    it('should show "Redirecting..." when clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.social).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      expect(screen.getByRole('button', { name: /redirecting/i })).toBeInTheDocument();
    });

    it('should disable button during loading', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.social).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      expect(screen.getByRole('button')).toBeDisabled();
    });
  });

  describe('error handling', () => {
    it('should log error when OAuth fails', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(authClient.signIn.social).mockRejectedValue(new Error('OAuth error'));

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'OAuth sign-in error',
          expect.any(Error),
          expect.objectContaining({ provider: 'google' })
        );
      });
    });

    it('should reset loading state on error', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.social).mockRejectedValue(new Error('OAuth error'));

      render(<OAuthButton provider="google">Sign in</OAuthButton>);

      // Act
      await user.click(screen.getByRole('button'));

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
      });
    });
  });
});
