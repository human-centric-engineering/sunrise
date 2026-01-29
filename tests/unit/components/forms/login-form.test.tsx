/**
 * LoginForm Component Tests
 *
 * Tests the LoginForm component which handles:
 * - Email/password authentication
 * - OAuth authentication integration
 * - Unverified email handling with resend option
 * - OAuth error display from URL params
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/login-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '@/components/forms/login-form';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: {
      email: vi.fn(),
      social: vi.fn(),
    },
    getSession: vi.fn().mockResolvedValue({
      data: {
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
        },
      },
    }),
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

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn().mockResolvedValue({ success: true }),
    identify: vi.fn().mockResolvedValue({ success: true }),
    page: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    isReady: true,
    isEnabled: true,
    providerName: 'Console',
  })),
  EVENTS: {
    USER_SIGNED_UP: 'user_signed_up',
    USER_LOGGED_IN: 'user_logged_in',
    USER_LOGGED_OUT: 'user_logged_out',
  },
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/login'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: LoginForm Component
 */
describe('components/forms/login-form', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

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

    // Default: no URL params
    const { useSearchParams } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );

    // Mock fetch for verification email
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render email input field', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert
      const emailInput = screen.getByLabelText(/email/i);
      expect(emailInput).toBeInTheDocument();
      expect(emailInput).toHaveAttribute('type', 'email');
      expect(emailInput).toHaveAttribute('placeholder', 'you@example.com');
    });

    it('should render password input field', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert
      const passwordInput = screen.getByLabelText('Password');
      expect(passwordInput).toBeInTheDocument();
      expect(passwordInput).toHaveAttribute('type', 'password');
    });

    it('should render sign in button', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert
      const submitButton = screen.getByRole('button', { name: /sign in/i });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });

    it('should render OAuth buttons', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert: OAuth section should be present
      const googleButton = screen.getByRole('button', { name: /google/i });
      expect(googleButton).toBeInTheDocument();
    });

    it('should not show error message initially', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert
      const errorElement = screen.queryByText(/invalid|error|failed/i);
      expect(errorElement).not.toBeInTheDocument();
    });
  });

  describe('form validation', () => {
    it('should show error for invalid email format', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'invalid-email');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
      });
    });

    it('should show error for empty email', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<LoginForm />);

      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act: Fill only password
      await user.type(passwordInput, 'password123');
      await user.click(submitButton);

      // Assert - must be specific to match validation error, not label or divider text
      await waitFor(() => {
        expect(screen.getByText(/email is required/i)).toBeInTheDocument();
      });
    });

    it('should show error for empty password', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act: Fill only email
      await user.type(emailInput, 'test@example.com');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/password is required/i)).toBeInTheDocument();
      });
    });
  });

  describe('form submission', () => {
    it('should call authClient.signIn.email with form data', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(authClient.signIn.email).toHaveBeenCalledWith(
          {
            email: 'test@example.com',
            password: 'Password123!',
          },
          expect.any(Object)
        );
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      // Make signIn hang
      vi.mocked(authClient.signIn.email).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /signing in/i })).toBeInTheDocument();
      });
    });

    it('should disable inputs during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(() => new Promise(() => {}));

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(emailInput).toBeDisabled();
        expect(passwordInput).toBeDisabled();
      });
    });

    it('should redirect to dashboard on successful login', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/dashboard');
      });
    });

    it('should redirect to custom callbackUrl when provided', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('callbackUrl=/settings') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/settings');
      });
    });
  });

  describe('error handling', () => {
    it('should display error message on failed login', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onError?.({
          error: { message: 'Invalid email or password' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'wrongpassword');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument();
      });
    });

    it('should display OAuth error from URL params', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'error=access_denied&error_description=User cancelled login'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<LoginForm />);

      // Assert
      expect(screen.getByText(/user cancelled login/i)).toBeInTheDocument();
    });

    it('should display generic OAuth error when description is missing', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('error=server_error') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<LoginForm />);

      // Assert
      expect(screen.getByText(/oauth authentication failed/i)).toBeInTheDocument();
    });

    it('should handle unexpected errors gracefully', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockRejectedValue(new Error('Network error'));

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
      });
    });
  });

  describe('unverified email handling', () => {
    it('should show send verification button for unverified email error', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onError?.({
          error: { message: 'Email not verified' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'unverified@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /send verification email/i })
        ).toBeInTheDocument();
      });
    });

    it('should send verification email when button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onError?.({
          error: { message: 'Email not verified' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act: Login attempt
      await user.type(emailInput, 'unverified@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Wait for send verification button
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /send verification email/i })
        ).toBeInTheDocument();
      });

      // Act: Click send verification
      const sendButton = screen.getByRole('button', { name: /send verification email/i });
      await user.click(sendButton);

      // Assert
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/auth/send-verification-email',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ email: 'unverified@example.com' }),
          })
        );
      });
    });

    it('should show success message after sending verification email', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onError?.({
          error: { message: 'Email not verified' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'unverified@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /send verification email/i })
        ).toBeInTheDocument();
      });

      const sendButton = screen.getByRole('button', { name: /send verification email/i });
      await user.click(sendButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/verification email sent/i)).toBeInTheDocument();
      });
    });

    it('should show error if sending verification email fails', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onError?.({
          error: { message: 'Email not verified' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Rate limited' }),
      } as Response);

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'unverified@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /send verification email/i })
        ).toBeInTheDocument();
      });

      const sendButton = screen.getByRole('button', { name: /send verification email/i });
      await user.click(sendButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/rate limited/i)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper autocomplete attributes', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');

      expect(emailInput).toHaveAttribute('autocomplete', 'email');
      expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
    });

    it('should have associated labels for inputs', () => {
      // Arrange & Act
      render(<LoginForm />);

      // Assert: Labels should be connected to inputs
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('analytics tracking', () => {
    it('should call identify with user ID from session on successful login', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { useAnalytics } = await import('@/lib/analytics');
      const mockIdentify = vi.fn().mockResolvedValue({ success: true });
      const mockTrack = vi.fn().mockResolvedValue({ success: true });

      vi.mocked(useAnalytics).mockReturnValue({
        identify: mockIdentify,
        track: mockTrack,
        page: vi.fn().mockResolvedValue({ success: true }),
        reset: vi.fn().mockResolvedValue({ success: true }),
        isReady: true,
        isEnabled: true,
        providerName: 'Console',
      });

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
      });
    });

    it('should call track with USER_LOGGED_IN event on successful login', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { useAnalytics } = await import('@/lib/analytics');
      const mockIdentify = vi.fn().mockResolvedValue({ success: true });
      const mockTrack = vi.fn().mockResolvedValue({ success: true });

      vi.mocked(useAnalytics).mockReturnValue({
        identify: mockIdentify,
        track: mockTrack,
        page: vi.fn().mockResolvedValue({ success: true }),
        reset: vi.fn().mockResolvedValue({ success: true }),
        isReady: true,
        isEnabled: true,
        providerName: 'Console',
      });

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('user_logged_in', { method: 'email' });
      });
    });

    it('should call identify before track on successful login', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');
      const { useAnalytics } = await import('@/lib/analytics');
      const mockIdentify = vi.fn().mockResolvedValue({ success: true });
      const mockTrack = vi.fn().mockResolvedValue({ success: true });

      vi.mocked(useAnalytics).mockReturnValue({
        identify: mockIdentify,
        track: mockTrack,
        page: vi.fn().mockResolvedValue({ success: true }),
        reset: vi.fn().mockResolvedValue({ success: true }),
        isReady: true,
        isEnabled: true,
        providerName: 'Console',
      });

      vi.mocked(authClient.signIn.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onRequest?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onRequest>>[0]
        );
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });

      render(<LoginForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText('Password');
      const submitButton = screen.getByRole('button', { name: /sign in/i });

      // Act
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalled();
        expect(mockTrack).toHaveBeenCalled();
      });

      // Verify identify was called before track using invocationCallOrder
      expect(mockIdentify.mock.invocationCallOrder[0]).toBeLessThan(
        mockTrack.mock.invocationCallOrder[0]
      );
    });
  });
});
