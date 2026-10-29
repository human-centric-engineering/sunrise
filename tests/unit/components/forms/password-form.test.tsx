// @vitest-environment happy-dom

/**
 * PasswordForm Component Tests
 *
 * Tests the PasswordForm component which handles:
 * - Password change functionality
 * - Password strength validation
 * - Password confirmation matching
 * - Success state display with auto-reset
 *
 * @see components/forms/password-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordForm } from '@/components/forms/password-form';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    changePassword: vi.fn(),
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
    track: vi.fn(),
  })),
  EVENTS: {
    PASSWORD_CHANGED: 'password_changed',
  },
}));

// Mock password strength utility
vi.mock('@/lib/utils/password-strength', () => ({
  calculatePasswordStrength: vi.fn((password: string) => {
    if (password.length < 8) {
      return { percentage: 25, label: 'Weak', color: 'bg-red-500' };
    }
    if (password.length < 12) {
      return { percentage: 50, label: 'Fair', color: 'bg-orange-500' };
    }
    if (password.length < 16) {
      return { percentage: 75, label: 'Good', color: 'bg-yellow-500' };
    }
    return { percentage: 100, label: 'Strong', color: 'bg-green-500' };
  }),
}));

/**
 * Test Suite: PasswordForm Component
 */
/** What better-auth's client resolves when the password changed. */
const CHANGED = { data: { token: null, user: { id: 'u1' } }, error: null } as never;

/** What it resolves when it refused: it never throws a refusal. */
const REFUSED = (code: string, message: string) => ({
  data: null,
  error: { code, message, status: 400, statusText: 'Bad Request' },
});

describe('components/forms/password-form', () => {
  let mockTrack: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock analytics
    const { useAnalytics } = await import('@/lib/analytics');
    mockTrack = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAnalytics).mockReturnValue({
      track: mockTrack,
      identify: vi.fn(),
      page: vi.fn(),
      reset: vi.fn(),
      isReady: true,
      isEnabled: true,
    } as unknown as ReturnType<typeof useAnalytics>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render current password input field', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const currentPasswordInput = screen.getByLabelText('Current Password');
      expect(currentPasswordInput).toBeInTheDocument();
      expect(currentPasswordInput).toHaveAttribute('placeholder', 'Enter your current password');
    });

    it('should render new password input field', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      expect(newPasswordInput).toBeInTheDocument();
      expect(newPasswordInput).toHaveAttribute('placeholder', 'Enter a new password');
    });

    it('should render confirm password input field', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      expect(confirmPasswordInput).toBeInTheDocument();
      expect(confirmPasswordInput).toHaveAttribute('placeholder', 'Confirm your new password');
    });

    it('should render submit button', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const submitButton = screen.getByRole('button', { name: /change password/i });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });

    it('should not show error message initially', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const errorElement = screen.queryByText(/error|failed|incorrect/i);
      expect(errorElement).not.toBeInTheDocument();
    });

    it('should not show success message initially', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const successMessage = screen.queryByText(/password changed successfully/i);
      expect(successMessage).not.toBeInTheDocument();
    });
  });

  describe('form validation', () => {
    it('should show error for empty current password', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<PasswordForm />);

      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act: Fill only new passwords
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/current password is required/i)).toBeInTheDocument();
      });
    });

    it('should show error for empty new password', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act: Fill only current and confirm passwords
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText(/password must be at least|password is required/i)
        ).toBeInTheDocument();
      });
    });

    it('should show error when passwords do not match', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act: Enter mismatched passwords
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'DifferentPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/passwords don't match/i)).toBeInTheDocument();
      });
    });

    it('should show error for weak new password', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act: Enter weak password
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'weak');
      await user.type(confirmPasswordInput, 'weak');
      await user.click(submitButton);

      // Assert: Should show validation error from passwordSchema
      await waitFor(() => {
        const errorMessage = screen.queryByText(/password must be at least|password must contain/i);
        expect(errorMessage).toBeInTheDocument();
      });
    });
  });

  describe('password strength indicator', () => {
    it('should display password strength when new password is entered', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<PasswordForm />);

      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });

      // Act
      await user.type(newPasswordInput, 'StrongPassword123!');

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/password strength:/i)).toBeInTheDocument();
      });
    });

    it('should not display password strength when new password is empty', () => {
      // Arrange & Act
      render(<PasswordForm />);

      // Assert
      const strengthIndicator = screen.queryByText(/password strength:/i);
      expect(strengthIndicator).not.toBeInTheDocument();
    });
  });

  describe('form submission', () => {
    it('should call authClient.changePassword with correct data', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockResolvedValue(CHANGED);

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(authClient.changePassword).toHaveBeenCalledWith({
          currentPassword: 'CurrentPassword123!',
          newPassword: 'NewPassword123!',
          revokeOtherSessions: true,
        });
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      // Make changePassword hang
      vi.mocked(authClient.changePassword).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /changing password/i })).toBeInTheDocument();
      });
    });

    it('should disable inputs during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockImplementation(() => new Promise(() => {}));

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(currentPasswordInput).toBeDisabled();
        expect(newPasswordInput).toBeDisabled();
        expect(confirmPasswordInput).toBeDisabled();
      });
    });

    it('should show success message on successful password change', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockResolvedValue(CHANGED);

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/password changed successfully/i)).toBeInTheDocument();
        expect(
          screen.getByText(/other sessions have been logged out for security/i)
        ).toBeInTheDocument();
      });
    });

    it('should track PASSWORD_CHANGED event on successful password change', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockResolvedValue(CHANGED);

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert - Analytics track should be called with PASSWORD_CHANGED event
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('password_changed');
      });
    });

    it('should clear form after successful password change', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockResolvedValue(CHANGED);

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Act
      await user.type(currentPasswordInput, 'CurrentPassword123!');
      await user.type(newPasswordInput, 'NewPassword123!');
      await user.type(confirmPasswordInput, 'NewPassword123!');
      await user.click(submitButton);

      // Assert: Form should be replaced with success message
      await waitFor(() => {
        expect(screen.getByText(/password changed successfully/i)).toBeInTheDocument();
      });

      // Form fields should not be visible
      expect(screen.queryByLabelText('Current Password')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('New Password')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Confirm New Password')).not.toBeInTheDocument();
    });

    it('should auto-hide success message after 5 seconds', async () => {
      // Use fake timers for this specific test
      vi.useFakeTimers();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.changePassword).mockResolvedValue(CHANGED);

      render(<PasswordForm />);

      const currentPasswordInput = screen.getByLabelText('Current Password');
      const newPasswordInput = screen.getByLabelText(/^new password/i, { selector: 'input' });
      const confirmPasswordInput = screen.getByLabelText('Confirm New Password');
      const submitButton = screen.getByRole('button', { name: /change password/i });

      // Use fireEvent for fake timer compatibility
      fireEvent.change(currentPasswordInput, { target: { value: 'CurrentPassword123!' } });
      fireEvent.change(newPasswordInput, { target: { value: 'NewPassword123!' } });
      fireEvent.change(confirmPasswordInput, { target: { value: 'NewPassword123!' } });

      await act(async () => {
        fireEvent.click(submitButton);
        // Flush promises to let the form submit
        await Promise.resolve();
      });

      // Success message should be visible
      expect(screen.getByText(/password changed successfully/i)).toBeInTheDocument();

      // Fast-forward 5 seconds
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Success message should be hidden, form should be visible again
      expect(screen.queryByText(/password changed successfully/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Current Password')).toBeInTheDocument();

      // Restore real timers
      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    // better-auth's client answers a refusal as `{ data: null, error }` and
    // never throws one (no `throw: true` in lib/auth/client.ts). Only a
    // network failure rejects.
    async function submitWith(result: unknown, kind: 'resolve' | 'reject' = 'resolve') {
      const user = userEvent.setup({ delay: null });
      const { authClient } = await import('@/lib/auth/client');
      if (kind === 'resolve') {
        vi.mocked(authClient.changePassword).mockResolvedValue(result);
      } else {
        vi.mocked(authClient.changePassword).mockRejectedValue(result);
      }

      render(<PasswordForm />);

      await user.type(screen.getByLabelText('Current Password'), 'WrongPassword123!');
      await user.type(
        screen.getByLabelText(/^new password/i, { selector: 'input' }),
        'NewPassword123!'
      );
      await user.type(screen.getByLabelText('Confirm New Password'), 'NewPassword123!');
      await user.click(screen.getByRole('button', { name: /change password/i }));
    }

    it('shows a wrong current password under that field, not a success', async () => {
      await submitWith(REFUSED('INVALID_PASSWORD', 'Invalid password'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Current password is incorrect');
      // Under the field too, and the field takes focus: it is what needs fixing.
      const field = screen.getByLabelText('Current Password');
      expect(field).toHaveFocus();
      expect(screen.getAllByText('Current password is incorrect')).toHaveLength(2);
      expect(screen.queryByText(/password changed successfully/i)).not.toBeInTheDocument();
      expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it("shows any other refusal in better-auth's words", async () => {
      await submitWith(REFUSED('SESSION_EXPIRED', 'Session expired'));

      expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
      expect(screen.queryByText(/password changed successfully/i)).not.toBeInTheDocument();
    });

    it('shows the fallback for a network failure, not the browser text', async () => {
      await submitWith(new TypeError('Failed to fetch'), 'reject');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not change your password. Try again in a moment.'
      );
      expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
    });

    it('puts the error beside Change Password and brings it into focus', async () => {
      await submitWith(REFUSED('SESSION_EXPIRED', 'Session expired'));

      const alert = await screen.findByRole('alert');
      expect(alert.nextElementSibling).toBe(
        screen.getByRole('button', { name: /change password/i })
      );
      expect(alert).toHaveFocus();
    });
  });
});
