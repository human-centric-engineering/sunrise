/**
 * OAuth Buttons Component Tests
 *
 * Tests the OAuthButtons and OAuthButton components for:
 * - Rendering in different modes (signin vs invitation)
 * - Passing invitation props correctly
 * - Button text changes based on mode
 * - Divider text changes based on mode
 * - Loading states during OAuth flow
 * - Click handling and OAuth initiation
 *
 * Test Coverage:
 * - Signin mode rendering
 * - Invitation mode rendering
 * - OAuth button interaction
 * - Invitation token/email prop passing
 * - Loading state display
 * - Error handling
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/oauth-buttons.tsx
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/oauth-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OAuthButtons } from '@/components/forms/oauth-buttons';

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
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: OAuthButtons Component
 *
 * Tests the OAuth buttons section that displays available OAuth providers.
 */
describe('components/forms/oauth-buttons', () => {
  let authClient: { signIn: { social: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked auth client
    const auth = await import('@/lib/auth/client');
    authClient = auth.authClient as unknown as { signIn: { social: ReturnType<typeof vi.fn> } };

    // Default mock behavior: OAuth succeeds
    authClient.signIn.social.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signin mode', () => {
    it('should render Google OAuth button with "Continue with Google" text', () => {
      // Arrange & Act: Render in signin mode (default)
      render(<OAuthButtons />);

      // Assert: Verify button text
      const button = screen.getByRole('button', { name: /continue with google/i });
      expect(button).toBeInTheDocument();
    });

    it('should render divider with "Or continue with email" text', () => {
      // Arrange & Act: Render in signin mode
      render(<OAuthButtons mode="signin" />);

      // Assert: Verify divider text
      expect(screen.getByText(/or continue with email/i)).toBeInTheDocument();
    });

    it('should use callbackUrl prop when provided', async () => {
      // Arrange: Setup user event
      const user = userEvent.setup();

      // Act: Render with custom callback URL
      render(<OAuthButtons callbackUrl="/custom-dashboard" />);

      // Act: Click the OAuth button
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify OAuth was initiated with correct callback
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'google',
            callbackURL: '/custom-dashboard',
          })
        );
      });
    });

    it('should use default callback URL when not provided', async () => {
      // Arrange: Setup user event
      const user = userEvent.setup();

      // Act: Render without callback URL
      render(<OAuthButtons />);

      // Act: Click the OAuth button
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify OAuth was initiated with default callback
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'google',
            callbackURL: '/dashboard',
          })
        );
      });
    });
  });

  describe('invitation mode', () => {
    it('should render Google OAuth button with "Accept with Google" text', () => {
      // Arrange & Act: Render in invitation mode
      render(<OAuthButtons mode="invitation" />);

      // Assert: Verify button text
      const button = screen.getByRole('button', { name: /accept with google/i });
      expect(button).toBeInTheDocument();
    });

    it('should render divider with "Or set a password" text', () => {
      // Arrange & Act: Render in invitation mode
      render(<OAuthButtons mode="invitation" />);

      // Assert: Verify divider text
      expect(screen.getByText(/or set a password/i)).toBeInTheDocument();
    });

    it('should pass invitation token and email to OAuth button', async () => {
      // Arrange: Setup user event and invitation data
      const user = userEvent.setup();
      const invitationToken = 'test-token-123';
      const invitationEmail = 'invited@example.com';

      // Act: Render with invitation props
      render(
        <OAuthButtons
          mode="invitation"
          invitationToken={invitationToken}
          invitationEmail={invitationEmail}
          callbackUrl="/dashboard"
        />
      );

      // Act: Click the OAuth button
      const button = screen.getByRole('button', { name: /accept with google/i });
      await user.click(button);

      // Assert: Verify OAuth was initiated with invitation data in additionalData
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith({
          provider: 'google',
          callbackURL: '/dashboard',
          additionalData: {
            invitationToken: invitationToken,
            invitationEmail: invitationEmail,
          },
        });
      });
    });

    it('should not pass invitation props when not provided', async () => {
      // Arrange: Setup user event
      const user = userEvent.setup();

      // Act: Render in invitation mode without invitation props
      render(<OAuthButtons mode="invitation" callbackUrl="/dashboard" />);

      // Act: Click the OAuth button
      const button = screen.getByRole('button', { name: /accept with google/i });
      await user.click(button);

      // Assert: Verify OAuth was initiated without invitation data
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith({
          provider: 'google',
          callbackURL: '/dashboard',
          // No invitationToken or invitationEmail
        });
      });
    });
  });

  describe('OAuth button interaction', () => {
    it('should show loading state when OAuth is initiated', async () => {
      // Arrange: Setup user event and delay OAuth response
      const user = userEvent.setup();
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      authClient.signIn.social.mockImplementation(async () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: true });
          }, 100);
        });
      });

      // Act: Render and click button
      render(<OAuthButtons />);
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify loading text is shown
      expect(screen.getByRole('button', { name: /redirecting/i })).toBeInTheDocument();

      // Wait for OAuth to complete
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalled();
      });
    });

    it('should disable button during OAuth flow', async () => {
      // Arrange: Setup user event and delay OAuth response
      const user = userEvent.setup();
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      authClient.signIn.social.mockImplementation(async () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: true });
          }, 100);
        });
      });

      // Act: Render and click button
      render(<OAuthButtons />);
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify button is disabled during loading
      const loadingButton = screen.getByRole('button', { name: /redirecting/i });
      expect(loadingButton).toBeDisabled();

      // Wait for OAuth to complete
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalled();
      });
    });

    it('should handle OAuth initiation errors gracefully', async () => {
      // Arrange: Setup user event and mock OAuth error
      const user = userEvent.setup();
      const { logger } = await import('@/lib/logging');

      authClient.signIn.social.mockRejectedValue(new Error('OAuth provider unavailable'));

      // Act: Render and click button
      render(<OAuthButtons />);
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify error was logged
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'OAuth sign-in error',
          expect.any(Error),
          expect.objectContaining({ provider: 'google' })
        );
      });

      // Assert: Verify button returns to normal state after error
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /continue with google/i })).not.toBeDisabled();
      });
    });
  });

  describe('callback URL handling', () => {
    it('should read callbackUrl from query params when prop not provided', async () => {
      // Arrange: Setup user event and mock searchParams
      const user = userEvent.setup();
      const { useSearchParams } = await import('next/navigation');

      // Mock query params with callbackUrl
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('callbackUrl=/profile') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act: Render without callbackUrl prop
      render(<OAuthButtons />);
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify OAuth was initiated with query param callback
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: '/profile',
          })
        );
      });
    });

    it('should prioritize callbackUrl prop over query params', async () => {
      // Arrange: Setup user event with conflicting URLs
      const user = userEvent.setup();
      const { useSearchParams } = await import('next/navigation');

      // Mock query params with callbackUrl
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('callbackUrl=/from-query') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act: Render with explicit callbackUrl prop
      render(<OAuthButtons callbackUrl="/from-prop" />);
      const button = screen.getByRole('button', { name: /continue with google/i });
      await user.click(button);

      // Assert: Verify OAuth uses prop value, not query param
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackURL: '/from-prop',
          })
        );
      });
    });
  });

  describe('accessibility', () => {
    it('should have accessible button role', () => {
      // Arrange & Act: Render component
      render(<OAuthButtons />);

      // Assert: Verify button has correct role
      const button = screen.getByRole('button', { name: /continue with google/i });
      expect(button).toHaveAttribute('type', 'button');
    });

    it('should be keyboard accessible', async () => {
      // Arrange: Setup user event for keyboard interaction
      const user = userEvent.setup();

      // Act: Render and tab to button
      render(<OAuthButtons />);
      const button = screen.getByRole('button', { name: /continue with google/i });

      // Act: Focus on button
      button.focus();
      expect(button).toHaveFocus();

      // Act: Press Enter key
      await user.keyboard('{Enter}');

      // Assert: Verify OAuth was initiated
      await waitFor(() => {
        expect(authClient.signIn.social).toHaveBeenCalled();
      });
    });
  });

  describe('rendering', () => {
    it('should render Google icon', () => {
      // Arrange & Act: Render component
      render(<OAuthButtons />);

      // Assert: Verify SVG icon is present
      const button = screen.getByRole('button', { name: /continue with google/i });
      const svg = button.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    });

    it('should render with proper spacing structure', () => {
      // Arrange & Act: Render component
      const { container } = render(<OAuthButtons />);

      // Assert: Verify component structure (has spacing classes)
      const outerDiv = container.firstChild;
      expect(outerDiv).toHaveClass('space-y-4');
    });

    it('should render divider with border and text', () => {
      // Arrange & Act: Render component
      render(<OAuthButtons />);

      // Assert: Verify divider text is present
      const dividerText = screen.getByText(/or continue with email/i);
      expect(dividerText).toBeInTheDocument();
      expect(dividerText).toHaveClass('bg-background');
    });
  });
});
