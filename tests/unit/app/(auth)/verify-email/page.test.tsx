/**
 * Email Verification Pending Page Tests
 *
 * Tests the email verification pending page client component that appears
 * after email/password signup when email verification is required.
 *
 * File Structure:
 * - page.tsx - Server component with metadata, renders VerifyEmailClientContent
 * - verify-email-content.tsx - Client component with pending state UI (tested here)
 *
 * Test Coverage:
 * - Rendering without email parameter (generic message)
 * - Rendering with email parameter (personalized message)
 * - Resend button visibility (only when email param is present)
 * - Resend flow (button click, API call, loading state)
 * - Success message after successful resend
 * - Error handling if resend fails
 * - Login link visibility
 * - Suspense boundary fallback
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/(auth)/verify-email/verify-email-content.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VerifyEmailClientContent } from '@/app/(auth)/verify-email/verify-email-content';

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
  usePathname: vi.fn(() => '/verify-email'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: Email Verification Pending Page
 *
 * Tests the page shown after signup requiring email verification.
 */
describe('VerifyEmailClientContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fetch globally
    global.fetch = vi.fn();
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
      render(<VerifyEmailClientContent />);

      // Assert: Page renders successfully
      const hasCheckEmailMessage = screen.queryByText(/check your email/i);
      expect(hasCheckEmailMessage).toBeTruthy();
    });
  });

  /**
   * Rendering Tests Without Email Parameter
   *
   * Tests rendering when no email parameter is provided in URL.
   */
  describe('rendering without email parameter', () => {
    beforeEach(async () => {
      // Mock useSearchParams to return empty params
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );
    });

    it('should render "Check your email" title', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Title appears
      await waitFor(() => {
        expect(screen.getByText(/check your email/i)).toBeInTheDocument();
      });
    });

    it('should render generic verification message without email', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Generic message appears (without email address)
      await waitFor(() => {
        expect(
          screen.getByText(/we've sent a verification link to your email address/i)
        ).toBeInTheDocument();
      });
    });

    it('should render mail icon', async () => {
      // Arrange & Act
      const { container } = render(<VerifyEmailClientContent />);

      // Assert: Mail icon container is rendered
      await waitFor(() => {
        const iconContainer = container.querySelector('[class*="bg-primary"]');
        expect(iconContainer).toBeInTheDocument();
      });
    });

    it('should render instructions about clicking link', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Instructions appear
      await waitFor(() => {
        expect(
          screen.getByText(/click the link in the email to verify your account and get started/i)
        ).toBeInTheDocument();
      });
    });

    it('should render expiration notice', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Expiration notice appears
      await waitFor(() => {
        expect(
          screen.getByText(/the verification link will expire in 24 hours/i)
        ).toBeInTheDocument();
      });
    });

    it('should NOT render resend button when email is not provided', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Resend button is not present
      await waitFor(() => {
        expect(screen.getByText(/check your email/i)).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /resend verification email/i })
      ).not.toBeInTheDocument();
    });

    it('should render login link', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Login link is present
      await waitFor(() => {
        const loginLink = screen.getByRole('link', { name: /sign in/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });
    });

    it('should render "Already verified?" text with login link', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: "Already verified?" text appears
      await waitFor(() => {
        expect(screen.getByText(/already verified\?/i)).toBeInTheDocument();
      });
    });
  });

  /**
   * Rendering Tests With Email Parameter
   *
   * Tests rendering when email parameter is provided in URL.
   */
  describe('rendering with email parameter', () => {
    const testEmail = 'user@example.com';

    beforeEach(async () => {
      // Mock useSearchParams to return email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(`email=${testEmail}`) as unknown as ReturnType<typeof useSearchParams>
      );
    });

    it('should render personalized message with email address', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Email is displayed in message
      await waitFor(() => {
        expect(screen.getByText(/we've sent a verification link to/i)).toBeInTheDocument();
        expect(screen.getByText(testEmail)).toBeInTheDocument();
      });
    });

    it('should render email address in bold', async () => {
      // Arrange & Act
      const { container } = render(<VerifyEmailClientContent />);

      // Assert: Email is wrapped in <strong> tag
      await waitFor(() => {
        const strongElement = container.querySelector('strong');
        expect(strongElement).toBeInTheDocument();
        expect(strongElement?.textContent).toBe(testEmail);
      });
    });

    it('should render resend button when email is provided', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Resend button is present
      await waitFor(() => {
        const resendButton = screen.getByRole('button', {
          name: /resend verification email/i,
        });
        expect(resendButton).toBeInTheDocument();
      });
    });

    it('should render resend button as outline variant', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Button has outline variant styling
      await waitFor(() => {
        const resendButton = screen.getByRole('button', {
          name: /resend verification email/i,
        });
        expect(resendButton.className).toContain('outline');
      });
    });

    it('should render resend button at full width', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Button has full width styling
      await waitFor(() => {
        const resendButton = screen.getByRole('button', {
          name: /resend verification email/i,
        });
        expect(resendButton.className).toContain('w-full');
      });
    });

    it('should NOT disable resend button initially', async () => {
      // Arrange & Act
      render(<VerifyEmailClientContent />);

      // Assert: Button is enabled initially
      await waitFor(() => {
        const resendButton = screen.getByRole('button', {
          name: /resend verification email/i,
        });
        expect(resendButton).not.toBeDisabled();
      });
    });
  });

  /**
   * Resend Flow Tests
   *
   * Tests the resend verification email functionality.
   */
  describe('resend flow', () => {
    const testEmail = 'user@example.com';

    beforeEach(async () => {
      // Mock useSearchParams to return email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(`email=${testEmail}`) as unknown as ReturnType<typeof useSearchParams>
      );
    });

    it('should call API when resend button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: API called with correct data
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/auth/send-verification-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: testEmail }),
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

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Loading state is shown
      expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

      // Wait for completion
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /sending/i })).not.toBeInTheDocument();
      });
    });

    it('should disable button during resend', async () => {
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

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Button is disabled during loading
      expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

      // Wait for completion
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /sending/i })).not.toBeInTheDocument();
      });
    });

    it('should show success message after successful resend', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Success message appears
      await waitFor(() => {
        expect(
          screen.getByText(/verification email sent successfully\. check your inbox\./i)
        ).toBeInTheDocument();
      });
    });

    it('should change button text to "Email sent!" after successful resend', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Button text changes
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /email sent!/i })).toBeInTheDocument();
      });
    });

    it('should disable button after successful resend', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Button is disabled after success
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /email sent!/i })).toBeDisabled();
      });
    });

    it('should show success message with green styling', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Success message has green styling
      await waitFor(() => {
        const successMessage = screen.getByText(
          /verification email sent successfully\. check your inbox\./i
        );
        expect(successMessage.className).toMatch(/text-green/);
      });
    });
  });

  /**
   * Error Handling Tests
   *
   * Tests error scenarios for the resend functionality.
   */
  describe('error handling', () => {
    const testEmail = 'user@example.com';

    beforeEach(async () => {
      // Mock useSearchParams to return email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(`email=${testEmail}`) as unknown as ReturnType<typeof useSearchParams>
      );
    });

    it('should show error message when API returns error', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Failed to send email' }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Error message appears
      await waitFor(() => {
        expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
      });
    });

    it('should show default error message when API fails', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Error message appears (shows Error.message when it's an Error instance)
      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });
    });

    it('should show error message with destructive styling', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Error' }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Error message container has destructive styling
      await waitFor(() => {
        const errorMessage = screen.getByText(/failed to resend verification email/i);
        // The error message is wrapped in a div with destructive styling
        expect(errorMessage.className).toMatch(/text-destructive/);
      });
    });

    it('should re-enable button after error', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Error' }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Button is re-enabled after error
      await waitFor(() => {
        expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole('button', { name: /resend verification email/i });
      expect(retryButton).not.toBeDisabled();
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

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: First attempt (fails)
      await user.click(resendButton);

      // Assert: Error appears
      await waitFor(() => {
        expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
      });

      // Act: Retry
      const retryButton = screen.getByRole('button', { name: /resend verification email/i });
      await user.click(retryButton);

      // Assert: Error is cleared and success message appears
      await waitFor(() => {
        expect(screen.queryByText(/failed to resend verification email/i)).not.toBeInTheDocument();
        expect(screen.getByText(/verification email sent successfully/i)).toBeInTheDocument();
      });
    });

    it('should handle missing email parameter gracefully', async () => {
      // Arrange
      // Override mock to have no email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );

      render(<VerifyEmailClientContent />);

      // Wait for component to render
      await waitFor(() => {
        expect(screen.getByText(/check your email/i)).toBeInTheDocument();
      });

      // Assert: Resend button should not be visible without email parameter
      expect(
        screen.queryByRole('button', { name: /resend verification email/i })
      ).not.toBeInTheDocument();
    });
  });

  /**
   * Login Link Tests
   *
   * Tests the "Already verified? Sign in" link visibility.
   */
  describe('login link', () => {
    it('should always render login link regardless of email parameter', async () => {
      // Arrange: No email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<VerifyEmailClientContent />);

      // Assert: Login link is present
      await waitFor(() => {
        const loginLink = screen.getByRole('link', { name: /sign in/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });
    });

    it('should render login link with email parameter', async () => {
      // Arrange: With email parameter
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('email=user@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      render(<VerifyEmailClientContent />);

      // Assert: Login link is still present
      await waitFor(() => {
        const loginLink = screen.getByRole('link', { name: /sign in/i });
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveAttribute('href', '/login');
      });
    });

    it('should render login link after successful resend', async () => {
      // Arrange
      const user = userEvent.setup();
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('email=user@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Login link is still visible after success
      await waitFor(() => {
        expect(screen.getByText(/verification email sent successfully/i)).toBeInTheDocument();
      });

      const loginLink = screen.getByRole('link', { name: /sign in/i });
      expect(loginLink).toBeInTheDocument();
    });

    it('should render login link after error', async () => {
      // Arrange
      const user = userEvent.setup();
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('email=user@example.com') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Error' }),
      } as Response);

      render(<VerifyEmailClientContent />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /resend verification email/i })
        ).toBeInTheDocument();
      });

      const resendButton = screen.getByRole('button', { name: /resend verification email/i });

      // Act: Click resend button
      await user.click(resendButton);

      // Assert: Login link is still visible after error
      await waitFor(() => {
        expect(screen.getByText(/failed to resend verification email/i)).toBeInTheDocument();
      });

      const loginLink = screen.getByRole('link', { name: /sign in/i });
      expect(loginLink).toBeInTheDocument();
    });
  });
});
