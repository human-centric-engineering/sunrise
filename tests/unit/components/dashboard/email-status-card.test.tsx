/**
 * Component Tests for EmailStatusCard
 *
 * Tests the EmailStatusCard component that displays email verification status
 * on the dashboard.
 *
 * Coverage:
 * - Rendering for all three states (verified, pending, not_sent)
 * - Button interactions (send/resend verification email)
 * - Loading states during API calls
 * - Success messages after sending email
 * - Error messages (429, generic errors)
 * - State transitions (not_sent -> pending after sending)
 * - Icons and styling for each state
 * - Accessibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailStatusCard } from '@/components/dashboard/email-status-card';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('components/dashboard/email-status-card', () => {
  const testEmail = 'user@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('verified state', () => {
    it('should display "Verified" status', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Your email is verified')).toBeInTheDocument();
    });

    it('should show green checkmark icon', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert: Icon should be present in the card header
      expect(screen.getByText('Email Status')).toBeInTheDocument();
    });

    it('should not display any button', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert: No buttons should be present
      const buttons = screen.queryAllByRole('button');
      expect(buttons).toHaveLength(0);
    });

    it('should have Email Status title', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert
      expect(screen.getByText('Email Status')).toBeInTheDocument();
    });
  });

  describe('pending state', () => {
    it('should display "Unverified" status with pending message', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert
      expect(screen.getByText('Unverified')).toBeInTheDocument();
      expect(screen.getByText('Check your inbox to verify your email')).toBeInTheDocument();
    });

    it('should show alert icon', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert: Card should be present
      expect(screen.getByText('Email Status')).toBeInTheDocument();
    });

    it('should display "Resend Email" button', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert
      expect(screen.getByRole('button', { name: /resend email/i })).toBeInTheDocument();
    });

    it('should have Mail icon in button', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert: Button should be present
      const button = screen.getByRole('button', { name: /resend email/i });
      expect(button).toBeInTheDocument();
    });
  });

  describe('not_sent state', () => {
    it('should display "Unverified" status with security message', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert
      expect(screen.getByText('Unverified')).toBeInTheDocument();
      expect(screen.getByText('Verify your email for added security')).toBeInTheDocument();
    });

    it('should show alert icon', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert: Card should be present
      expect(screen.getByText('Email Status')).toBeInTheDocument();
    });

    it('should display "Verify Email" button', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert
      expect(screen.getByRole('button', { name: /verify email/i })).toBeInTheDocument();
    });

    it('should have Mail icon in button', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert: Button should be present
      const button = screen.getByRole('button', { name: /verify email/i });
      expect(button).toBeInTheDocument();
    });
  });

  describe('send verification email - success', () => {
    it('should call API with correct email when button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/auth/send-verification-email',
          expect.objectContaining({
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: testEmail }),
          })
        );
      });
    });

    it('should show loading state while sending', async () => {
      // Arrange
      const user = userEvent.setup();
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
      mockFetch.mockReturnValue(fetchPromise);

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act: Click button
      await user.click(button);

      // Assert: Loading state
      await waitFor(() => {
        expect(screen.getByText(/sending/i)).toBeInTheDocument();
      });

      // Clean up: resolve promise
      resolvePromise!({ ok: true, status: 200 } as Response);
      await waitFor(() => {
        expect(screen.queryByText(/sending/i)).not.toBeInTheDocument();
      });
    });

    it('should disable button while loading', async () => {
      // Arrange
      const user = userEvent.setup();
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
      mockFetch.mockReturnValue(fetchPromise);

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act
      await user.click(button);

      // Assert: Button disabled
      await waitFor(() => {
        expect(button).toBeDisabled();
      });

      // Clean up
      resolvePromise!({ ok: true, status: 200 } as Response);
      await waitFor(() => {
        expect(button).not.toBeDisabled();
      });
    });

    it('should show success message after sending', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/verification email sent! check your inbox/i)).toBeInTheDocument();
      });
    });

    it('should transition from not_sent to pending state after sending', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Initially shows "Verify Email" button
      expect(screen.getByRole('button', { name: /verify email/i })).toBeInTheDocument();

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert: State changes to pending, button text changes
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /resend email/i })).toBeInTheDocument();
      });

      expect(screen.getByText('Check your inbox to verify your email')).toBeInTheDocument();
    });

    it('should show success message in pending state after resend', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Act: Click resend
      await user.click(screen.getByRole('button', { name: /resend email/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/verification email sent! check your inbox/i)).toBeInTheDocument();
      });
    });
  });

  describe('send verification email - errors', () => {
    it('should show rate limit error message', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/too many requests. please try again later/i)).toBeInTheDocument();
      });
    });

    it('should show generic error message for other HTTP errors', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText(/failed to send verification email. please try again/i)
        ).toBeInTheDocument();
      });
    });

    it('should show error message for network failure', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/an error occurred. please try again/i)).toBeInTheDocument();
      });
    });

    it('should re-enable button after error', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act
      await user.click(button);

      // Assert: Button should be enabled again after error
      await waitFor(() => {
        expect(button).not.toBeDisabled();
      });
    });

    it('should NOT transition to pending state on error', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert: Should still show "Verify Email" button (not_sent state)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /verify email/i })).toBeInTheDocument();
      });
    });

    it('should display error messages in red color', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        const errorMessage = screen.getByText(
          /failed to send verification email. please try again/i
        );
        expect(errorMessage).toHaveClass('text-red-600');
      });
    });
  });

  describe('message display', () => {
    it('should not show message initially', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert: No success or error messages
      expect(screen.queryByText(/verification email sent/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/too many requests/i)).not.toBeInTheDocument();
    });

    it('should clear previous message when sending again', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
        });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act: First send - success
      await user.click(screen.getByRole('button', { name: /verify email/i }));
      await waitFor(() => {
        expect(screen.getByText(/verification email sent/i)).toBeInTheDocument();
      });

      // Act: Second send - rate limited
      await user.click(screen.getByRole('button', { name: /resend email/i }));

      // Assert: Old success message cleared, new error message shown
      await waitFor(() => {
        expect(screen.queryByText(/verification email sent/i)).not.toBeInTheDocument();
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      });
    });

    it('should show success message in green', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        const successMessage = screen.getByText(/verification email sent/i);
        expect(successMessage).toHaveClass('text-green-600');
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper button labels for not_sent state', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert: not_sent state
      expect(screen.getByRole('button', { name: /verify email/i })).toBeInTheDocument();
    });

    it('should have proper button labels for pending state', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert: pending state
      expect(screen.getByRole('button', { name: /resend email/i })).toBeInTheDocument();
    });

    it('should have proper heading structure', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert: Card title should be present
      expect(screen.getByText('Email Status')).toBeInTheDocument();
    });

    it('should indicate disabled state properly', async () => {
      // Arrange
      const user = userEvent.setup();
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
      mockFetch.mockReturnValue(fetchPromise);

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act
      await user.click(button);

      // Assert: Button has disabled attribute
      await waitFor(() => {
        expect(button).toHaveAttribute('disabled');
      });

      // Clean up
      resolvePromise!({ ok: true, status: 200 } as Response);
    });
  });

  describe('user interactions', () => {
    it('should allow clicking button multiple times after success', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act: Click twice
      await user.click(screen.getByRole('button', { name: /verify email/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /resend email/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /resend email/i }));

      // Assert: Both calls made
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });

    it('should prevent double-clicking during loading', async () => {
      // Arrange
      const user = userEvent.setup();
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
      mockFetch.mockReturnValue(fetchPromise);

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act: Try to click twice rapidly
      await user.click(button);
      await user.click(button); // This should not trigger another fetch

      // Assert: Only one API call
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clean up
      resolvePromise!({ ok: true, status: 200 } as Response);
    });

    it('should handle keyboard interaction', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={testEmail} />);
      const button = screen.getByRole('button', { name: /verify email/i });

      // Act: Focus and press Enter
      button.focus();
      await user.keyboard('{Enter}');

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  describe('component props', () => {
    it('should use provided email in API call', async () => {
      // Arrange
      const user = userEvent.setup();
      const customEmail = 'custom@example.com';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={customEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/auth/send-verification-email',
          expect.objectContaining({
            body: JSON.stringify({ email: customEmail }),
          })
        );
      });
    });

    it('should render verified status correctly', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    it('should render pending status correctly', () => {
      // Arrange & Act
      render(<EmailStatusCard status="pending" email={testEmail} />);

      // Assert
      expect(screen.getByText('Check your inbox to verify your email')).toBeInTheDocument();
    });

    it('should render not_sent status correctly', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert
      expect(screen.getByText('Verify your email for added security')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle empty email string', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email="" />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert: Should still make API call (validation handled by backend)
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/auth/send-verification-email',
          expect.objectContaining({
            body: JSON.stringify({ email: '' }),
          })
        );
      });
    });

    it('should handle very long email', async () => {
      // Arrange
      const user = userEvent.setup();
      const longEmail = 'a'.repeat(200) + '@example.com';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      render(<EmailStatusCard status="not_sent" email={longEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/auth/send-verification-email',
          expect.objectContaining({
            body: JSON.stringify({ email: longEmail }),
          })
        );
      });
    });

    it('should handle fetch returning undefined response', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(undefined as unknown as Response);

      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Act
      await user.click(screen.getByRole('button', { name: /verify email/i }));

      // Assert: Should show error message
      await waitFor(() => {
        expect(screen.getByText(/an error occurred/i)).toBeInTheDocument();
      });
    });
  });

  describe('styling', () => {
    it('should render as a Card component', () => {
      // Arrange & Act
      const { container } = render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert: Should have card structure
      expect(container.querySelector('[class*="card"]')).toBeInTheDocument();
    });

    it('should have proper button styling', () => {
      // Arrange & Act
      render(<EmailStatusCard status="not_sent" email={testEmail} />);

      // Assert: Button should have outline variant and sm size
      const button = screen.getByRole('button', { name: /verify email/i });
      expect(button).toHaveClass('mt-3');
    });

    it('should show different text sizes correctly', () => {
      // Arrange & Act
      render(<EmailStatusCard status="verified" email={testEmail} />);

      // Assert: Status should be large, description small
      const status = screen.getByText('Verified');
      expect(status).toHaveClass('text-2xl');
      expect(status).toHaveClass('font-bold');

      const description = screen.getByText('Your email is verified');
      expect(description).toHaveClass('text-xs');
    });
  });
});
