/**
 * AcceptInviteForm Component Tests
 *
 * Tests the invitation acceptance form with password setting and OAuth support.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/accept-invite-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AcceptInviteForm } from '@/components/forms/accept-invite-form';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock child components
vi.mock('@/components/forms/oauth-buttons', () => ({
  OAuthButtons: vi.fn(
    ({ mode, callbackUrl, errorCallbackUrl, invitationToken, invitationEmail }) => (
      <div data-testid="oauth-buttons" data-mode={mode}>
        <span data-testid="callback-url">{callbackUrl}</span>
        <span data-testid="error-callback-url">{errorCallbackUrl}</span>
        <span data-testid="invitation-token">{invitationToken}</span>
        <span data-testid="invitation-email">{invitationEmail}</span>
      </div>
    )
  ),
}));

vi.mock('@/components/forms/password-strength', () => ({
  PasswordStrength: vi.fn(({ password }) => (
    <div data-testid="password-strength">{password ? `Strength: ${password.length}` : ''}</div>
  )),
}));

vi.mock('@/components/forms/form-error', () => ({
  FormError: vi.fn(({ message }) =>
    message ? <div data-testid="form-error">{message}</div> : null
  ),
}));

// Mock auth client
const mockGetSession = vi.fn();
const mockSignInEmail = vi.fn();
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    getSession: () => mockGetSession(),
    signIn: {
      email: (...args: unknown[]) => mockSignInEmail(...args),
    },
  },
}));

// Mock analytics
const mockIdentify = vi.fn().mockResolvedValue({ success: true });
const mockTrackFormSubmitted = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn(),
    identify: mockIdentify,
    page: vi.fn(),
    reset: vi.fn(),
    isReady: true,
    isEnabled: true,
  })),
}));

vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({
    trackFormSubmitted: mockTrackFormSubmitted,
  })),
}));

/**
 * Test Suite: AcceptInviteForm Component
 */
describe('components/forms/accept-invite-form', () => {
  const mockPush = vi.fn();
  const mockRefresh = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default mock: valid invitation
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ name: 'Test User', role: 'member' });
    vi.mocked(apiClient.post).mockResolvedValue({ success: true });

    // Default mock: signIn returns session with user ID (for analytics identify)
    mockSignInEmail.mockResolvedValue({ data: { user: { id: 'user-123' } } });

    // Default router mock
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
      replace: vi.fn(),
      refresh: mockRefresh,
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('loading state', () => {
    it('should show loading skeleton initially', async () => {
      // Arrange - delay the API response
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ name: 'Test', role: 'member' }), 100))
      );

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      expect(screen.getByText(/loading invitation/i)).toBeInTheDocument();
    });

    it('should show animated skeleton bars', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ name: 'Test', role: 'member' }), 100))
      );

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      const { container } = render(<AcceptInviteForm />);

      // Assert
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('invalid invitation state', () => {
    it('should show invalid state when token is missing', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert - use exact text match for heading
      await waitFor(() => {
        expect(screen.getByText('Invalid Invitation')).toBeInTheDocument();
      });
    });

    it('should show invalid state when email is missing', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert - use exact text match for heading
      await waitFor(() => {
        expect(screen.getByText('Invalid Invitation')).toBeInTheDocument();
      });
    });

    it('should show invalid state when API returns NOT_FOUND', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Not found', 'NOT_FOUND'));

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid invitation/i)).toBeInTheDocument();
        expect(screen.getByText(/invitation not found/i)).toBeInTheDocument();
      });
    });

    it('should show back to login link in invalid state', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute(
          'href',
          '/login'
        );
      });
    });
  });

  describe('expired invitation state', () => {
    it('should show expired state when API returns INVITATION_EXPIRED', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Expired', 'INVITATION_EXPIRED')
      );

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invitation expired/i)).toBeInTheDocument();
      });
    });

    it('should show contact admin message for expired invitations', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Expired', 'INVITATION_EXPIRED')
      );

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
      });
    });

    it('should show back to login link in expired state', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Expired', 'INVITATION_EXPIRED')
      );

      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute(
          'href',
          '/login'
        );
      });
    });
  });

  describe('valid invitation form', () => {
    beforeEach(async () => {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
    });

    it('should render form when invitation is valid', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert - use exact label text to avoid matching multiple elements
      await waitFor(() => {
        expect(screen.getByLabelText('Password')).toBeInTheDocument();
      });
    });

    it('should display invitation name from API', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({ name: 'John Doe', role: 'admin' });

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByDisplayValue('John Doe')).toBeInTheDocument();
      });
    });

    it('should display email from URL params', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByDisplayValue('test@example.com')).toBeInTheDocument();
      });
    });

    it('should have email field disabled', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByLabelText(/email/i)).toBeDisabled();
      });
    });

    it('should have name field disabled', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue({ name: 'John Doe', role: 'admin' });

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByLabelText(/name/i)).toBeDisabled();
      });
    });

    it('should render password strength component', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('password-strength')).toBeInTheDocument();
      });
    });

    it('should render OAuth buttons with invitation mode', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        const oauthButtons = screen.getByTestId('oauth-buttons');
        expect(oauthButtons).toHaveAttribute('data-mode', 'invitation');
      });
    });

    it('should pass invitation token to OAuth buttons', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('invitation-token')).toHaveTextContent('abc123');
      });
    });

    it('should pass invitation email to OAuth buttons', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('invitation-email')).toHaveTextContent('test@example.com');
      });
    });

    it('should show sign in link', async () => {
      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
      });
    });
  });

  describe('form validation', () => {
    beforeEach(async () => {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
    });

    it('should show error for short password', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act - type short password and blur
      const passwordInput = screen.getByLabelText(/^password$/i);
      await user.type(passwordInput, 'short');
      await user.tab();

      // Assert
      await waitFor(() => {
        const errors = screen.getAllByTestId('form-error');
        expect(errors.some((el) => el.textContent?.toLowerCase().includes('8'))).toBe(true);
      });
    });

    it('should show error when passwords do not match', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);

      await user.type(passwordInput, 'ValidPass123!');
      await user.type(confirmInput, 'DifferentPass123!');
      await user.tab();

      // Assert
      await waitFor(() => {
        const errors = screen.getAllByTestId('form-error');
        expect(errors.some((el) => el.textContent?.toLowerCase().includes('match'))).toBe(true);
      });
    });
  });

  describe('form submission', () => {
    beforeEach(async () => {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
    });

    it('should submit form with correct data', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { apiClient } = await import('@/lib/api/client');

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith('/api/auth/accept-invite', {
          body: expect.objectContaining({
            token: 'abc123',
            email: 'test@example.com',
            password: 'ValidPass123!',
            confirmPassword: 'ValidPass123!',
          }),
        });
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
      );

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      expect(screen.getByRole('button', { name: /activating/i })).toBeDisabled();
    });

    it('should show success message after submission', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/account activated successfully/i)).toBeInTheDocument();
      });
    });

    it('should redirect to dashboard after success', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Wait for success state
      await waitFor(() => {
        expect(screen.getByText(/account activated successfully/i)).toBeInTheDocument();
      });

      // Advance timer for redirect
      vi.advanceTimersByTime(1500);

      // Assert
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard');
      });
    });

    it('should identify user and track invite form submission on success', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert - identify should be called with user ID before tracking
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
        expect(mockTrackFormSubmitted).toHaveBeenCalledWith('invite');
      });

      // Verify identify was called before trackFormSubmitted
      const identifyOrder = mockIdentify.mock.invocationCallOrder[0];
      const trackOrder = mockTrackFormSubmitted.mock.invocationCallOrder[0];
      expect(identifyOrder).toBeLessThan(trackOrder);
    });

    it('should hide sign in link after success', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Verify link exists before submission
      expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
      });
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
    });

    it('should show API error message', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Invalid token'));

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid token/i)).toBeInTheDocument();
      });
    });

    it('should show generic error for unexpected errors', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
      });
    });

    it('should re-enable form after error', async () => {
      // Arrange
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Error'));

      render(<AcceptInviteForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      });

      // Act
      await user.type(screen.getByLabelText(/^password$/i), 'ValidPass123!');
      await user.type(screen.getByLabelText(/confirm password/i), 'ValidPass123!');
      await user.click(screen.getByRole('button', { name: /activate account/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /activate account/i })).not.toBeDisabled();
      });
    });
  });

  describe('OAuth error handling', () => {
    it('should show OAuth email mismatch error from URL', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'token=abc123&email=test@example.com&error=invitation_was_sent_to_other@example.com'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invitation was sent to/i)).toBeInTheDocument();
      });
    });

    it('should show generic OAuth error for unknown errors', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'token=abc123&email=test@example.com&error=unknown_oauth_error'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unable to sign in/i)).toBeInTheDocument();
      });
    });

    it('should preserve OAuth error after invitation load', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'token=abc123&email=test@example.com&error=some_error'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert - error should remain after invitation loads successfully
      await waitFor(() => {
        // Form should be visible (valid invitation loaded)
        expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
        // But error should still be shown
        expect(screen.getByText(/unable to sign in/i)).toBeInTheDocument();
      });
    });
  });

  describe('error callback URL', () => {
    it('should construct error callback URL with token and email', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        const errorCallbackUrl = screen.getByTestId('error-callback-url');
        expect(errorCallbackUrl.textContent).toContain('token=abc123');
        expect(errorCallbackUrl.textContent).toContain('email=test%40example.com');
      });
    });
  });

  describe('API calls', () => {
    it('should call invitation metadata endpoint on mount', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('token=abc123&email=test@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<AcceptInviteForm />);

      // Assert
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('/api/v1/invitations/metadata')
        );
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('token=abc123'));
        expect(apiClient.get).toHaveBeenCalledWith(
          expect.stringContaining('email=test%40example.com')
        );
      });
    });
  });
});
