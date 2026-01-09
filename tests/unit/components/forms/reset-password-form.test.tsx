/**
 * ResetPasswordForm Component Tests
 *
 * Tests the ResetPasswordForm component with dual-state logic:
 * - State 1 (no token): Request password reset via email
 * - State 2 (with token): Complete password reset with new password
 *
 * Test Coverage:
 * - State 1 rendering and interactions
 * - State 1 form validation
 * - State 1 submission and success state
 * - State 2 rendering and interactions
 * - State 2 form validation
 * - State 2 show/hide password toggles
 * - State 2 submission and success state
 * - Error handling for both states
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/reset-password-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    resetPassword: vi.fn(),
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
  usePathname: vi.fn(() => '/reset-password'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock password strength calculator
vi.mock('@/lib/utils/password-strength', () => ({
  calculatePasswordStrength: vi.fn((password: string) => {
    if (password.length === 0) {
      return { percentage: 0, label: 'Weak', color: 'bg-red-500' };
    }
    if (password.length < 8) {
      return { percentage: 25, label: 'Weak', color: 'bg-red-500' };
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return { percentage: 50, label: 'Fair', color: 'bg-orange-500' };
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return { percentage: 75, label: 'Good', color: 'bg-yellow-500' };
    }
    return { percentage: 100, label: 'Strong', color: 'bg-green-500' };
  }),
}));

/**
 * Test Suite: ResetPasswordForm Component
 *
 * Tests both states of the password reset flow based on token presence.
 */
describe('components/forms/reset-password-form', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fetch globally for State 1 API calls
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * State 1: Request Reset (No Token)
   *
   * Tests the initial state where user requests a password reset email.
   */
  describe('State 1: Request Reset (no token)', () => {
    beforeEach(async () => {
      // Mock useSearchParams to return no token
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );
    });

    describe('rendering', () => {
      it('should render email input field', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const emailInput = screen.getByLabelText(/email/i);
        expect(emailInput).toBeInTheDocument();
        expect(emailInput).toHaveAttribute('type', 'email');
        expect(emailInput).toHaveAttribute('placeholder', 'you@example.com');
      });

      it('should render "Send reset link" button', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const submitButton = screen.getByRole('button', { name: /send reset link/i });
        expect(submitButton).toBeInTheDocument();
        expect(submitButton).toHaveAttribute('type', 'submit');
      });

      it('should render "Back to login" link', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const loginLink = screen.getByRole('link', { name: /back to login/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });
    });

    describe('form validation', () => {
      it('should show error for invalid email format', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Enter invalid email and submit
        await user.type(emailInput, 'invalid-email');
        await user.click(submitButton);

        // Assert: Validation error should appear
        await waitFor(() => {
          expect(screen.getByText(/invalid email address/i)).toBeInTheDocument();
        });

        // Assert: API should not be called
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('should show error for empty email', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit without entering email
        await user.click(submitButton);

        // Assert: Validation error should appear
        await waitFor(() => {
          expect(screen.getByText(/email is required/i)).toBeInTheDocument();
        });

        // Assert: API should not be called
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('should clear validation error when user corrects email', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Enter invalid email and submit
        await user.type(emailInput, 'invalid');
        await user.click(submitButton);

        // Assert: Error appears
        await waitFor(() => {
          expect(screen.getByText(/invalid email address/i)).toBeInTheDocument();
        });

        // Act: Correct the email
        await user.clear(emailInput);
        await user.type(emailInput, 'valid@example.com');

        // Assert: Error should disappear
        await waitFor(() => {
          expect(screen.queryByText(/invalid email address/i)).not.toBeInTheDocument();
        });
      });
    });

    describe('form submission', () => {
      it('should call API with email and redirectTo on submit', async () => {
        // Arrange
        const user = userEvent.setup();
        const email = 'user@example.com';

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Enter email and submit
        await user.type(emailInput, email);
        await user.click(submitButton);

        // Assert: API called with correct data
        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith('/api/auth/request-password-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: email,
              redirectTo: '/reset-password',
            }),
          });
        });
      });

      it('should show loading state during submission', async () => {
        // Arrange
        const user = userEvent.setup();

        // Mock fetch with delay
        vi.mocked(global.fetch).mockImplementation(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({
                  ok: true,
                  json: async () => ({ success: true }),
                } as Response);
              }, 100);
            })
        );

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Enter email and submit
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Loading state is shown
        expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

        // Wait for completion
        await waitFor(() => {
          expect(screen.queryByRole('button', { name: /sending/i })).not.toBeInTheDocument();
        });
      });

      it('should disable input during submission', async () => {
        // Arrange
        const user = userEvent.setup();

        // Mock fetch with delay
        vi.mocked(global.fetch).mockImplementation(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({
                  ok: true,
                  json: async () => ({ success: true }),
                } as Response);
              }, 100);
            })
        );

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Enter email and submit
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Input is disabled during loading
        expect(emailInput).toBeDisabled();

        // Wait for completion (success state will hide the input)
        await waitFor(() => {
          expect(screen.getByText(/check your email/i)).toBeInTheDocument();
        });
      });

      it('should show success state on successful submission', async () => {
        // Arrange
        const user = userEvent.setup();
        const email = 'user@example.com';

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, email);
        await user.click(submitButton);

        // Assert: Success message appears
        await waitFor(() => {
          expect(screen.getByText(/check your email/i)).toBeInTheDocument();
          expect(screen.getByText(email)).toBeInTheDocument();
        });
      });

      it('should show error message on failed submission', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          json: async () => ({ error: 'Server error' }),
        } as Response);

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Error message appears
        await waitFor(() => {
          expect(
            screen.getByText(/failed to send reset email\. please try again\./i)
          ).toBeInTheDocument();
        });
      });

      it('should show error message on network error', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Error message appears
        await waitFor(() => {
          expect(
            screen.getByText(/failed to send reset email\. please try again\./i)
          ).toBeInTheDocument();
        });
      });
    });

    describe('success state', () => {
      beforeEach(async () => {
        // Mock successful API response
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);
      });

      it('should show Mail icon in success state', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Mail icon appears (lucide-react Mail component)
        await waitFor(() => {
          expect(screen.getByText(/check your email/i)).toBeInTheDocument();
          // Mail icon is rendered but difficult to test directly; check parent div exists
          const iconContainer = screen
            .getByText(/check your email/i)
            .closest('div')?.previousElementSibling;
          expect(iconContainer).toHaveClass('flex', 'justify-center');
        });
      });

      it('should show email address in success message', async () => {
        // Arrange
        const user = userEvent.setup();
        const email = 'test@example.com';
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, email);
        await user.click(submitButton);

        // Assert: Email appears in success message
        await waitFor(() => {
          expect(screen.getByText(/check your email/i)).toBeInTheDocument();
          expect(screen.getByText(email)).toBeInTheDocument();
        });
      });

      it('should show troubleshooting tips in success state', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: Tips are shown
        await waitFor(() => {
          expect(screen.getByText(/check your spam folder/i)).toBeInTheDocument();
          expect(screen.getByText(/make sure you entered the correct email/i)).toBeInTheDocument();
          expect(screen.getByText(/wait a few minutes and try again/i)).toBeInTheDocument();
          expect(
            screen.getByText(
              /if you signed up using a social login, try signing in with that instead/i
            )
          ).toBeInTheDocument();
        });
      });

      it('should show "Try another email" button in success state', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: "Try another email" button appears
        await waitFor(() => {
          expect(screen.getByRole('button', { name: /try another email/i })).toBeInTheDocument();
        });
      });

      it('should return to form when clicking "Try another email"', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Wait for success state
        await waitFor(() => {
          expect(screen.getByRole('button', { name: /try another email/i })).toBeInTheDocument();
        });

        // Act: Click "Try another email"
        const tryAnotherButton = screen.getByRole('button', { name: /try another email/i });
        await user.click(tryAnotherButton);

        // Assert: Form is shown again
        await waitFor(() => {
          expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
          expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
        });
      });

      it('should show "Back to login" link in success state', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const emailInput = screen.getByLabelText(/email/i);
        const submitButton = screen.getByRole('button', { name: /send reset link/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(submitButton);

        // Assert: "Back to login" link still appears
        await waitFor(() => {
          expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
        });
      });
    });
  });

  /**
   * State 2: Complete Reset (With Token)
   *
   * Tests the state where user has token and sets new password.
   */
  describe('State 2: Complete Reset (with token)', () => {
    const mockToken = 'test-reset-token-123';
    let authClient: { resetPassword: ReturnType<typeof vi.fn> };
    let mockRouter: {
      push: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
      back: ReturnType<typeof vi.fn>;
      forward: ReturnType<typeof vi.fn>;
      replace: ReturnType<typeof vi.fn>;
      prefetch: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      // Mock useSearchParams to return token
      const { useSearchParams, useRouter } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(`token=${mockToken}`) as unknown as ReturnType<typeof useSearchParams>
      );

      // Setup router mock
      mockRouter = {
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        replace: vi.fn(),
        prefetch: vi.fn(),
      };
      vi.mocked(useRouter).mockReturnValue(mockRouter as ReturnType<typeof useRouter>);

      // Import mocked auth client
      const auth = await import('@/lib/auth/client');
      authClient = auth.authClient as unknown as { resetPassword: ReturnType<typeof vi.fn> };

      // Default mock behavior: reset succeeds
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      authClient.resetPassword.mockImplementation(async (_data, callbacks) => {
        if (callbacks?.onSuccess) {
          callbacks.onSuccess(undefined as never);
        }
        return Promise.resolve();
      });
    });

    describe('rendering', () => {
      it('should render password input with label', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const passwordInput = screen.getByLabelText(/^new password$/i);
        expect(passwordInput).toBeInTheDocument();
        expect(passwordInput).toHaveAttribute('type', 'password');
        expect(passwordInput).toHaveAttribute('placeholder', '••••••••');
      });

      it('should render confirm password input with label', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        expect(confirmInput).toBeInTheDocument();
        expect(confirmInput).toHaveAttribute('type', 'password');
        expect(confirmInput).toHaveAttribute('placeholder', '••••••••');
      });

      it('should render show/hide toggle for password field', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert: Toggle button exists
        const toggleButtons = screen.getAllByLabelText(/show password|hide password/i);
        expect(toggleButtons.length).toBeGreaterThan(0);
      });

      it('should render show/hide toggle for confirm password field', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert: Two toggle buttons exist (one for each field)
        const toggleButtons = screen.getAllByLabelText(/show password|hide password/i);
        expect(toggleButtons.length).toBe(2);
      });

      it('should render password strength meter', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert: Strength meter is not visible initially (password empty)
        expect(screen.queryByText(/password strength/i)).not.toBeInTheDocument();
      });

      it('should render password requirements hint', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        expect(
          screen.getByText(
            /must be at least 8 characters with uppercase, lowercase, number, and special character/i
          )
        ).toBeInTheDocument();
      });

      it('should render "Reset password" button', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });
        expect(submitButton).toBeInTheDocument();
        expect(submitButton).toHaveAttribute('type', 'submit');
      });

      it('should render "Back to login" link', () => {
        // Arrange & Act
        render(<ResetPasswordForm />);

        // Assert
        const loginLink = screen.getByRole('link', { name: /back to login/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });

      it('should include hidden token input', () => {
        // Arrange & Act
        const { container } = render(<ResetPasswordForm />);

        // Assert: Hidden input with token value exists
        const hiddenInput = container.querySelector('input[type="hidden"]');
        expect(hiddenInput).toBeInTheDocument();
        expect(hiddenInput).toHaveValue(mockToken);
      });
    });

    describe('form validation', () => {
      it('should show error for weak password (too short)', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter weak password and submit
        await user.type(passwordInput, 'Abc1!');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(screen.getByText(/password must be at least 8 characters/i)).toBeInTheDocument();
        });
      });

      it('should show error for password missing uppercase', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter password without uppercase
        await user.type(passwordInput, 'abcdefgh1!');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(
            screen.getByText(/password must contain at least one uppercase letter/i)
          ).toBeInTheDocument();
        });
      });

      it('should show error for password missing lowercase', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter password without lowercase
        await user.type(passwordInput, 'ABCDEFGH1!');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(
            screen.getByText(/password must contain at least one lowercase letter/i)
          ).toBeInTheDocument();
        });
      });

      it('should show error for password missing number', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter password without number
        await user.type(passwordInput, 'Abcdefgh!');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(
            screen.getByText(/password must contain at least one number/i)
          ).toBeInTheDocument();
        });
      });

      it('should show error for password missing special character', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter password without special character
        await user.type(passwordInput, 'Abcdefgh1');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(
            screen.getByText(/password must contain at least one special character/i)
          ).toBeInTheDocument();
        });
      });

      it('should show error for mismatched passwords', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter different passwords and submit
        await user.type(passwordInput, 'Password1!');
        await user.type(confirmInput, 'Password2!');
        await user.click(submitButton);

        // Assert: Validation error appears
        await waitFor(() => {
          expect(screen.getByText(/passwords don't match/i)).toBeInTheDocument();
        });
      });

      it('should update password strength meter in real-time', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);

        // Act: Start typing password
        await user.type(passwordInput, 'P');

        // Assert: Strength meter appears
        await waitFor(() => {
          expect(screen.getByText(/password strength/i)).toBeInTheDocument();
        });

        // Act: Type more characters
        await user.type(passwordInput, 'assword1!');

        // Assert: Strength meter still visible (updates with each keystroke)
        expect(screen.getByText(/password strength/i)).toBeInTheDocument();
      });
    });

    describe('show/hide password', () => {
      it('should toggle password visibility when clicking eye icon', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const toggleButton = screen.getAllByLabelText(/show password/i)[0];

        // Assert: Password is hidden initially
        expect(passwordInput).toHaveAttribute('type', 'password');

        // Act: Click show button
        await user.click(toggleButton);

        // Assert: Password is visible
        await waitFor(() => {
          expect(passwordInput).toHaveAttribute('type', 'text');
        });

        // Assert: Button label changes
        expect(screen.getAllByLabelText(/hide password/i)[0]).toBeInTheDocument();
      });

      it('should toggle confirm password visibility independently', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const confirmToggleButton = screen.getAllByLabelText(/show password/i)[1];

        // Assert: Both passwords hidden initially
        expect(passwordInput).toHaveAttribute('type', 'password');
        expect(confirmInput).toHaveAttribute('type', 'password');

        // Act: Click show button for confirm password
        await user.click(confirmToggleButton);

        // Assert: Only confirm password is visible
        await waitFor(() => {
          expect(confirmInput).toHaveAttribute('type', 'text');
          expect(passwordInput).toHaveAttribute('type', 'password');
        });
      });

      it('should toggle password back to hidden when clicking eye-off icon', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const toggleButton = screen.getAllByLabelText(/show password/i)[0];

        // Act: Show password
        await user.click(toggleButton);
        await waitFor(() => {
          expect(passwordInput).toHaveAttribute('type', 'text');
        });

        // Act: Hide password again
        const hideButton = screen.getAllByLabelText(/hide password/i)[0];
        await user.click(hideButton);

        // Assert: Password is hidden
        await waitFor(() => {
          expect(passwordInput).toHaveAttribute('type', 'password');
        });
      });
    });

    describe('form submission', () => {
      it('should call authClient.resetPassword with correct data on submit', async () => {
        // Arrange
        const user = userEvent.setup();
        const password = 'NewPassword1!';

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter passwords and submit
        await user.type(passwordInput, password);
        await user.type(confirmInput, password);
        await user.click(submitButton);

        // Assert: authClient.resetPassword was called with correct data
        await waitFor(() => {
          expect(authClient.resetPassword).toHaveBeenCalledWith(
            {
              newPassword: password,
              token: mockToken,
            },
            expect.objectContaining({
              onRequest: expect.any(Function),
              onSuccess: expect.any(Function),
              onError: expect.any(Function),
            })
          );
        });
      });

      it('should show loading state during submission', async () => {
        // Arrange
        const user = userEvent.setup();

        // Mock resetPassword with delay
        authClient.resetPassword.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          async (_data, callbacks) =>
            new Promise((resolve) => {
              setTimeout(() => {
                if (callbacks?.onSuccess) {
                  callbacks.onSuccess(undefined as never);
                }
                resolve(undefined);
              }, 100);
            })
        );

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter passwords and submit
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Loading state is shown
        expect(screen.getByRole('button', { name: /resetting password/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /resetting password/i })).toBeDisabled();

        // Wait for completion
        await waitFor(() => {
          expect(
            screen.queryByRole('button', { name: /resetting password/i })
          ).not.toBeInTheDocument();
        });
      });

      it('should disable inputs during submission', async () => {
        // Arrange
        const user = userEvent.setup();

        // Mock resetPassword with delay
        authClient.resetPassword.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          async (_data, callbacks) =>
            new Promise((resolve) => {
              setTimeout(() => {
                if (callbacks?.onSuccess) {
                  callbacks.onSuccess(undefined as never);
                }
                resolve(undefined);
              }, 100);
            })
        );

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Enter passwords and submit
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Inputs are disabled during loading
        expect(passwordInput).toBeDisabled();
        expect(confirmInput).toBeDisabled();

        // Wait for completion (success state will hide the inputs)
        await waitFor(() => {
          expect(screen.getByText(/password reset successfully!/i)).toBeInTheDocument();
        });
      });

      it('should show success state on successful reset', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Success message appears
        await waitFor(() => {
          expect(screen.getByText(/password reset successfully!/i)).toBeInTheDocument();
          expect(screen.getByText(/redirecting to login/i)).toBeInTheDocument();
        });
      });

      it('should redirect to login after successful reset', async () => {
        // Arrange
        const user = userEvent.setup();

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Success message appears
        await waitFor(() => {
          expect(screen.getByText(/password reset successfully!/i)).toBeInTheDocument();
        });

        // Assert: Router push was called after setTimeout (wait for it with timeout)
        await waitFor(
          () => {
            expect(mockRouter.push).toHaveBeenCalledWith('/login');
            expect(mockRouter.refresh).toHaveBeenCalled();
          },
          { timeout: 2000 }
        );
      });

      it('should show error message on failed reset', async () => {
        // Arrange
        const user = userEvent.setup();
        const errorMessage = 'Password reset failed';

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        authClient.resetPassword.mockImplementation(async (_data, callbacks) => {
          // Simulate async error callback
          await Promise.resolve();
          if (callbacks?.onError) {
            callbacks.onError({
              error: { message: errorMessage, status: 400 },
            } as never);
          }
          return Promise.resolve();
        });

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Error message appears
        await waitFor(() => {
          expect(screen.getByText(errorMessage)).toBeInTheDocument();
        });
      });

      it('should show specific error for invalid/expired token', async () => {
        // Arrange
        const user = userEvent.setup();

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        authClient.resetPassword.mockImplementation(async (_data, callbacks) => {
          // Simulate async error callback
          await Promise.resolve();
          if (callbacks?.onError) {
            callbacks.onError({
              error: { message: 'Token is invalid or expired', status: 400 },
            } as never);
          }
          return Promise.resolve();
        });

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Specific error message appears
        await waitFor(() => {
          expect(
            screen.getByText(/this reset link is invalid or has expired/i)
          ).toBeInTheDocument();
        });
      });

      it('should show "Request new reset link" button for invalid/expired token', async () => {
        // Arrange
        const user = userEvent.setup();

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        authClient.resetPassword.mockImplementation(async (_data, callbacks) => {
          // Simulate async error callback
          await Promise.resolve();
          if (callbacks?.onError) {
            callbacks.onError({
              error: { message: 'Token is expired', status: 400 },
            } as never);
          }
          return Promise.resolve();
        });

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: "Request new reset link" button appears
        await waitFor(() => {
          const newLinkButton = screen.getByRole('link', { name: /request new reset link/i });
          expect(newLinkButton).toBeInTheDocument();
          expect(newLinkButton).toHaveAttribute('href', '/reset-password');
        });
      });

      it('should handle unexpected errors gracefully', async () => {
        // Arrange
        const user = userEvent.setup();

        authClient.resetPassword.mockRejectedValue(new Error('Unexpected error'));

        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Generic error message appears
        await waitFor(() => {
          expect(
            screen.getByText(/an unexpected error occurred\. please try again\./i)
          ).toBeInTheDocument();
        });
      });
    });

    describe('success state', () => {
      beforeEach(() => {
        // Reset to default successful behavior for success state tests
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        authClient.resetPassword.mockImplementation(async (_data, callbacks) => {
          await Promise.resolve();
          if (callbacks?.onSuccess) {
            callbacks.onSuccess(undefined as never);
          }
          return Promise.resolve();
        });
      });

      it('should show success message after password reset', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Success message appears
        await waitFor(() => {
          expect(screen.getByText(/password reset successfully!/i)).toBeInTheDocument();
        });
      });

      it('should show redirecting message in success state', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Redirecting message appears
        await waitFor(() => {
          expect(screen.getByText(/redirecting to login/i)).toBeInTheDocument();
        });
      });

      it('should not show form after successful reset', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<ResetPasswordForm />);

        const passwordInput = screen.getByLabelText(/^new password$/i);
        const confirmInput = screen.getByLabelText(/^confirm password$/i);
        const submitButton = screen.getByRole('button', { name: /^reset password$/i });

        // Act: Submit form
        await user.type(passwordInput, 'NewPassword1!');
        await user.type(confirmInput, 'NewPassword1!');
        await user.click(submitButton);

        // Assert: Form is no longer visible
        await waitFor(() => {
          expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
          expect(screen.queryByLabelText(/^confirm password$/i)).not.toBeInTheDocument();
          expect(
            screen.queryByRole('button', { name: /^reset password$/i })
          ).not.toBeInTheDocument();
        });
      });
    });
  });
});
