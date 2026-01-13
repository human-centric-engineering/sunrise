/**
 * Email Verification Callback Page Tests
 *
 * Tests the email verification callback page that handles redirects from
 * better-auth's email verification endpoint.
 *
 * Test Coverage:
 * - Success state (no error param) - redirects to dashboard
 * - Error state (error=invalid_token) - shows expired message
 * - Resend flow - email input, button click, API call
 * - Loading states during resend
 * - Success message after resend
 * - Error handling if resend fails
 * - Form validation (empty email)
 * - Suspense boundary fallback
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/(auth)/verify-email/callback/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VerifyEmailCallbackPage from '@/app/(auth)/verify-email/callback/page';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/verify-email/callback'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: Email Verification Callback Page
 *
 * Tests both success and error states of the verification callback flow.
 */
describe('app/(auth)/verify-email/callback/page', () => {
  let mockRouter: {
    push: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    back: ReturnType<typeof vi.fn>;
    forward: ReturnType<typeof vi.fn>;
    prefetch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fetch globally
    global.fetch = vi.fn();

    // Setup router mock
    mockRouter = {
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Suspense Boundary Tests
   *
   * Tests the Suspense fallback that wraps the content component.
   * Note: In test environment, Suspense doesn't suspend so the fallback
   * may not be visible. We test that the page renders without crashing instead.
   */
  describe('Suspense boundary', () => {
    it('should render page without crashing', () => {
      // Arrange & Act
      render(<VerifyEmailCallbackPage />);

      // Assert: Page renders (either fallback or content)
      // The component either shows success message or error state
      const hasSuccessMessage = screen.queryByText(/email verified!/i);
      const hasErrorMessage = screen.queryByText(/verification link expired/i);

      expect(hasSuccessMessage || hasErrorMessage).toBeTruthy();
    });
  });

  /**
   * Success State Tests (No Error Parameter)
   *
   * Tests the success flow where email verification succeeded.
   */
  describe('Success state (no error parameter)', () => {
    beforeEach(async () => {
      // Mock useSearchParams to return no error
      const { useSearchParams, useRouter } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );
      vi.mocked(useRouter).mockReturnValue(mockRouter as ReturnType<typeof useRouter>);
    });

    it('should render success message when no error param', async () => {
      // Arrange & Act
      render(<VerifyEmailCallbackPage />);

      // Assert: Success message appears
      await waitFor(() => {
        expect(screen.getByText(/email verified!/i)).toBeInTheDocument();
        expect(screen.getByText(/redirecting to dashboard/i)).toBeInTheDocument();
      });
    });

    it('should show success icon when verification succeeds', async () => {
      // Arrange & Act
      const { container } = render(<VerifyEmailCallbackPage />);

      // Assert: Success icon container is rendered (check for the green success styling)
      await waitFor(() => {
        const successMessage = screen.getByText(/email verified!/i);
        expect(successMessage).toBeInTheDocument();
        // Verify the green icon styling exists in the rendered output
        const greenIconContainer = container.querySelector('[class*="bg-green-100"]');
        expect(greenIconContainer).toBeInTheDocument();
      });
    });

    it('should redirect to dashboard when no error param', async () => {
      // Arrange & Act
      render(<VerifyEmailCallbackPage />);

      // Assert: Router replace is called with /dashboard
      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard');
      });
    });

    it('should not show error message or resend form on success', async () => {
      // Arrange & Act
      render(<VerifyEmailCallbackPage />);

      // Assert: Success state shown, no error UI
      await waitFor(() => {
        expect(screen.getByText(/email verified!/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/verification link expired/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /resend verification email/i })
      ).not.toBeInTheDocument();
    });
  });

  /**
   * Error State Tests (With Error Parameter)
   *
   * Tests the error flow where verification failed (expired/invalid token).
   */
  describe('Error state (error=invalid_token)', () => {
    beforeEach(async () => {
      // Mock useSearchParams to return error=invalid_token
      const { useSearchParams, useRouter } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('error=invalid_token') as unknown as ReturnType<typeof useSearchParams>
      );
      vi.mocked(useRouter).mockReturnValue(mockRouter as ReturnType<typeof useRouter>);
    });

    describe('rendering', () => {
      it('should render error message when error param is present', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Assert: Error message appears
        await waitFor(() => {
          expect(screen.getByText(/verification link expired/i)).toBeInTheDocument();
          expect(
            screen.getByText(
              /this verification link has expired or is invalid\. please request a new one\./i
            )
          ).toBeInTheDocument();
        });
      });

      it('should show error icon when verification fails', async () => {
        // Arrange & Act
        const { container } = render(<VerifyEmailCallbackPage />);

        // Assert: Error icon container is rendered (check for the amber error styling)
        await waitFor(() => {
          const errorTitle = screen.getByText(/verification link expired/i);
          expect(errorTitle).toBeInTheDocument();
          // Verify the amber icon styling exists in the rendered output
          const amberIconContainer = container.querySelector('[class*="bg-amber-100"]');
          expect(amberIconContainer).toBeInTheDocument();
        });
      });

      it('should render email input field in error state', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Assert: Email input is present
        await waitFor(() => {
          const emailInput = screen.getByLabelText(/email address/i);
          expect(emailInput).toBeInTheDocument();
          expect(emailInput).toHaveAttribute('type', 'email');
          expect(emailInput).toHaveAttribute('placeholder', 'you@example.com');
        });
      });

      it('should render "Resend Verification Email" button', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Assert: Resend button is present
        await waitFor(() => {
          const resendButton = screen.getByRole('button', {
            name: /resend verification email/i,
          });
          expect(resendButton).toBeInTheDocument();
        });
      });

      it('should render "Back to login" link', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Assert: Back to login link is present
        await waitFor(() => {
          const loginLink = screen.getByRole('link', { name: /back to login/i });
          expect(loginLink).toBeInTheDocument();
          expect(loginLink).toHaveAttribute('href', '/login');
        });
      });

      it('should disable resend button when email is empty', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Assert: Resend button is disabled when email is empty
        await waitFor(() => {
          const resendButton = screen.getByRole('button', {
            name: /resend verification email/i,
          });
          expect(resendButton).toBeDisabled();
        });
      });

      it('should not redirect to dashboard when error param is present', async () => {
        // Arrange & Act
        render(<VerifyEmailCallbackPage />);

        // Wait for component to render
        await waitFor(() => {
          expect(screen.getByText(/verification link expired/i)).toBeInTheDocument();
        });

        // Assert: Router replace is NOT called
        expect(mockRouter.replace).not.toHaveBeenCalled();
      });
    });

    describe('email input interaction', () => {
      it('should enable resend button when email is entered', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Assert: Button is disabled initially
        expect(resendButton).toBeDisabled();

        // Act: Enter email
        await user.type(emailInput, 'user@example.com');

        // Assert: Button is enabled
        expect(resendButton).not.toBeDisabled();
      });

      it('should update email state as user types', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);

        // Act: Type email
        await user.type(emailInput, 'test@example.com');

        // Assert: Input value is updated
        expect(emailInput).toHaveValue('test@example.com');
      });
    });

    describe('resend flow', () => {
      it('should show validation error when submitting with empty email', async () => {
        // Arrange
        const user = userEvent.setup();
        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Initially button is disabled for empty email
        expect(resendButton).toBeDisabled();

        // Act: Type then clear email
        const emailInput = screen.getByLabelText(/email address/i);
        await user.type(emailInput, 'test@example.com');
        await user.clear(emailInput);

        // Assert: Button is disabled again
        expect(resendButton).toBeDisabled();
      });

      it('should call API when resend button is clicked', async () => {
        // Arrange
        const user = userEvent.setup();
        const email = 'user@example.com';

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Enter email and click resend
        await user.type(emailInput, email);
        await user.click(resendButton);

        // Assert: API called with correct data
        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith('/api/auth/send-verification-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
        });
      });

      it('should show loading state during resend', async () => {
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

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Enter email and click resend
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Loading state is shown
        expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

        // Wait for completion
        await waitFor(() => {
          expect(screen.queryByRole('button', { name: /sending/i })).not.toBeInTheDocument();
        });
      });

      it('should disable email input during resend', async () => {
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

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Enter email and click resend
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Input is disabled during loading
        expect(emailInput).toBeDisabled();

        // Wait for completion
        await waitFor(() => {
          expect(screen.queryByRole('button', { name: /sending/i })).not.toBeInTheDocument();
        });
      });

      it('should show success message after successful resend', async () => {
        // Arrange
        const user = userEvent.setup();
        const email = 'user@example.com';

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Enter email and click resend
        await user.type(emailInput, email);
        await user.click(resendButton);

        // Assert: Success message appears
        await waitFor(() => {
          expect(screen.getByText(/verification email sent!/i)).toBeInTheDocument();
          expect(
            screen.getByText(/check your inbox for a new verification link/i)
          ).toBeInTheDocument();
          expect(screen.getByText(/the link will expire in 24 hours/i)).toBeInTheDocument();
        });
      });

      it('should hide form after successful resend', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Form is no longer visible
        await waitFor(() => {
          expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
          expect(
            screen.queryByRole('button', { name: /resend verification email/i })
          ).not.toBeInTheDocument();
        });
      });

      it('should still show "Back to login" link after successful resend', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: "Back to login" link still appears
        await waitFor(() => {
          expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
        });
      });
    });

    describe('error handling', () => {
      it('should show error message when API returns error', async () => {
        // Arrange
        const user = userEvent.setup();
        const errorMessage = 'Failed to send email';

        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          json: async () => ({ message: errorMessage }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Error message appears
        await waitFor(() => {
          expect(screen.getByText(errorMessage)).toBeInTheDocument();
        });
      });

      it('should show default error message when API returns malformed response', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          json: async () => ({}), // No message property
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Default error message appears
        await waitFor(() => {
          expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
        });
      });

      it('should show error message when API response is not JSON', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          json: async () => {
            throw new SyntaxError('Invalid JSON');
          },
        } as unknown as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Default error message appears
        await waitFor(() => {
          expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
        });
      });

      it('should show error message when network request fails', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Error message appears (checks for either the error message or default message)
        await waitFor(() => {
          const errorText = screen.getByText(/network error|failed to resend verification email/i);
          expect(errorText).toBeInTheDocument();
        });
      });

      it('should clear previous error when retrying', async () => {
        // Arrange
        const user = userEvent.setup();

        // First call fails
        vi.mocked(global.fetch)
          .mockResolvedValueOnce({
            ok: false,
            json: async () => ({ message: 'First error' }),
          } as Response)
          // Second call succeeds
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: First attempt (fails)
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Assert: Error appears
        await waitFor(() => {
          expect(screen.getByText('First error')).toBeInTheDocument();
        });

        // Act: Clear email, enter again, and retry
        await user.clear(emailInput);
        await user.type(emailInput, 'retry@example.com');
        await user.click(resendButton);

        // Assert: Error is cleared and success message appears
        await waitFor(() => {
          expect(screen.queryByText('First error')).not.toBeInTheDocument();
          expect(screen.getByText(/verification email sent!/i)).toBeInTheDocument();
        });
      });

      it('should keep form visible after error', async () => {
        // Arrange
        const user = userEvent.setup();

        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          json: async () => ({ message: 'Error' }),
        } as Response);

        render(<VerifyEmailCallbackPage />);

        await waitFor(() => {
          expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        });

        const emailInput = screen.getByLabelText(/email address/i);
        const resendButton = screen.getByRole('button', { name: /resend verification email/i });

        // Act: Submit form
        await user.type(emailInput, 'user@example.com');
        await user.click(resendButton);

        // Wait for error
        await waitFor(() => {
          expect(screen.getByText('Error')).toBeInTheDocument();
        });

        // Assert: Form is still visible for retry
        expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });
    });
  });

  /**
   * Different Error Parameters Tests
   *
   * Tests how the page handles different error parameter values.
   */
  describe('different error parameters', () => {
    it('should show error UI for any error parameter value', async () => {
      // Arrange
      const { useSearchParams, useRouter } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('error=some_other_error') as unknown as ReturnType<
          typeof useSearchParams
        >
      );
      vi.mocked(useRouter).mockReturnValue(mockRouter as ReturnType<typeof useRouter>);

      // Act
      render(<VerifyEmailCallbackPage />);

      // Assert: Error UI is shown (same as invalid_token)
      await waitFor(() => {
        expect(screen.getByText(/verification link expired/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
      });
    });

    it('should not redirect when any error parameter is present', async () => {
      // Arrange
      const { useSearchParams, useRouter } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('error=token_expired') as unknown as ReturnType<typeof useSearchParams>
      );
      vi.mocked(useRouter).mockReturnValue(mockRouter as ReturnType<typeof useRouter>);

      // Act
      render(<VerifyEmailCallbackPage />);

      // Wait for component to render
      await waitFor(() => {
        expect(screen.getByText(/verification link expired/i)).toBeInTheDocument();
      });

      // Assert: Router replace is NOT called
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });
  });
});
