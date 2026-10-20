// @vitest-environment happy-dom

/**
 * DeleteAccountForm Component Tests
 *
 * Tests the DeleteAccountForm component which handles:
 * - Account deletion confirmation flow
 * - Alert dialog interaction
 * - "DELETE" text confirmation validation
 * - API call to delete account
 * - Redirect after successful deletion
 * - Error handling
 *
 * @see components/forms/delete-account-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAccountForm } from '@/components/forms/delete-account-form';
import { apiClient } from '@/lib/api/client';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    delete: vi.fn(),
  },
  // The real class's constructor shape: the form branches on `status`.
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    details?: unknown;

    constructor(message: string, code?: string, status?: number, details?: unknown) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
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

// Mock analytics
const mockReset = vi.fn().mockResolvedValue({ success: true });
const mockTrack = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: mockTrack,
    identify: vi.fn(),
    page: vi.fn(),
    reset: mockReset,
    isReady: true,
    isEnabled: true,
    providerName: 'Console',
  })),
  EVENTS: {
    ACCOUNT_DELETED: 'account_deleted',
  },
}));

/**
 * Test Suite: DeleteAccountForm Component
 */
describe('components/forms/delete-account-form', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Clear analytics mocks
    mockReset.mockClear();
    mockTrack.mockClear();

    // Mock window.location.href
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render delete account warning section', () => {
      // Arrange & Act
      render(<DeleteAccountForm />);

      // Assert
      expect(screen.getByRole('heading', { name: /delete account/i })).toBeInTheDocument();
      expect(
        screen.getByText(
          /permanently delete your account and all associated data\. this action cannot be undone\./i
        )
      ).toBeInTheDocument();
    });

    it('should render delete account trigger button', () => {
      // Arrange & Act
      render(<DeleteAccountForm />);

      // Assert
      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });
      expect(deleteButton).toBeInTheDocument();
    });

    it('should not show confirmation dialog initially', () => {
      // Arrange & Act
      render(<DeleteAccountForm />);

      // Assert
      expect(screen.queryByText(/are you absolutely sure/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/type.*delete.*to confirm/i)).not.toBeInTheDocument();
    });

    it('should display warning icon', () => {
      // Arrange & Act
      const { container } = render(<DeleteAccountForm />);

      // Assert: AlertTriangle icon should be present
      const warningIcon = container.querySelector('svg');
      expect(warningIcon).toBeInTheDocument();
    });
  });

  describe('confirmation dialog', () => {
    it('should open dialog when delete button is clicked', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/are you absolutely sure/i)).toBeInTheDocument();
      });
    });

    it('should show confirmation input field when dialog opens', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });
    });

    it('should show cancel button in dialog', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });
    });

    it('should show delete action button in dialog', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        // When dialog is open, the action button should be visible
        // The trigger button is hidden (aria-hidden), so only one button is queryable by role
        const deleteActionButton = screen.getByRole('button', { name: /delete account/i });
        expect(deleteActionButton).toBeInTheDocument();
      });
    });

    it('should close dialog when cancel is clicked', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByText(/are you absolutely sure/i)).toBeInTheDocument();
      });

      // Act: Click cancel
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Assert: Dialog should close
      await waitFor(() => {
        expect(screen.queryByText(/are you absolutely sure/i)).not.toBeInTheDocument();
      });
    });

    it('should reset confirmation text when dialog closes', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Type confirmation
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      // Act: Close dialog
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Act: Reopen dialog
      await user.click(deleteButton);

      // Assert: Input should be empty
      await waitFor(() => {
        const newConfirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
        expect(newConfirmationInput).toHaveValue('');
      });
    });
  });

  describe('confirmation validation', () => {
    it('should disable delete action button when confirmation text is empty', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
        // The action button (second one) should be disabled
        const actionButton = actionButtons[actionButtons.length - 1];
        expect(actionButton).toBeDisabled();
      });
    });

    it('should disable delete action button when confirmation text is incorrect', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Type incorrect confirmation
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'WRONG');

      // Assert
      await waitFor(() => {
        const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
        const actionButton = actionButtons[actionButtons.length - 1];
        expect(actionButton).toBeDisabled();
      });
    });

    it('should enable delete action button when confirmation text is "DELETE"', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Type correct confirmation
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      // Assert
      await waitFor(() => {
        const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
        const actionButton = actionButtons[actionButtons.length - 1];
        expect(actionButton).not.toBeDisabled();
      });
    });

    it('should be case-sensitive (only "DELETE" works)', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Type lowercase
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'delete');

      // Assert
      await waitFor(() => {
        const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
        const actionButton = actionButtons[actionButtons.length - 1];
        expect(actionButton).toBeDisabled();
      });
    });
  });

  describe('account deletion', () => {
    it('should call apiClient.delete with correct endpoint and body', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
      const actionButton = actionButtons[actionButtons.length - 1];
      await user.click(actionButton);

      // Assert
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/users/me', {
          body: { confirmation: 'DELETE' },
        });
      });
    });

    it('should call API when delete button is clicked', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });

      // Make delete hang to prevent redirect
      vi.mocked(apiClient.delete).mockImplementation(() => new Promise(() => {}));

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButton = screen.getByRole('button', { name: /delete account/i });
      await user.click(actionButton);

      // Assert: API should be called
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
      });
    });

    it('should redirect to home page after successful deletion', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
      const actionButton = actionButtons[actionButtons.length - 1];
      await user.click(actionButton);

      // Assert: Should redirect to home page
      await waitFor(() => {
        expect(window.location.href).toBe('/');
      });
    });

    it('should not call API if confirmation text is not "DELETE"', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Try to delete without confirmation (button should be disabled)
      const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
      const actionButton = actionButtons[actionButtons.length - 1];

      // Note: Button is disabled, so click won't work, but we can verify it doesn't call API
      expect(actionButton).toBeDisabled();
      expect(apiClient.delete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should track account deletion and reset analytics identity after successful deletion', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
      const actionButton = actionButtons[actionButtons.length - 1];
      await user.click(actionButton);

      // Assert: Analytics reset should be called (event tracked server-side)
      await waitFor(() => {
        expect(mockReset).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
      });
    });
  });

  describe('a deletion that is still in progress (t-845)', () => {
    /** Open the dialog, type the confirmation and press the delete action. */
    async function confirmDeletion(user: ReturnType<typeof userEvent.setup>) {
      render(<DeleteAccountForm />);
      await user.click(screen.getByRole('button', { name: /^delete account$/i }));
      await user.type(await screen.findByLabelText(/type.*delete.*to confirm/i), 'DELETE');
      const actionButtons = screen.getAllByRole('button', { name: /delete account/i });
      await user.click(actionButtons[actionButtons.length - 1]);
    }

    const PENDING = { pending: true, requestedAt: '2026-10-20T11:59:55.000Z' };

    it('shows the "Deletion in progress" message in place of the confirmation, without leaving yet', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(PENDING);

      await confirmDeletion(user);

      expect(await screen.findByText('Deletion in progress')).toBeInTheDocument();
      expect(
        screen.getByText(/your account is closed and you have been signed out/i)
      ).toBeInTheDocument();
      // The confirmation form is gone, and the person has not been moved on.
      expect(screen.queryByLabelText(/type.*delete.*to confirm/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/are you absolutely sure/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      expect(window.location.href).toBe('');
    });

    it('still resets the analytics identity, as for a finished deletion', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(PENDING);

      await confirmDeletion(user);
      await screen.findByText('Deletion in progress');

      expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('shows the same message when another attempt already holds the deletion (409)', async () => {
      // The route has signed the person out either way: an error left in an
      // open dialog would strand them on a page with a dead session.
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('This account is already being deleted.', 'CONFLICT', 409)
      );

      await confirmDeletion(user);

      expect(await screen.findByText('Deletion in progress')).toBeInTheDocument();
      expect(screen.queryByText('This account is already being deleted.')).not.toBeInTheDocument();
      expect(mockReset).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(window.location.href).toBe('/');
    });

    it('leaves for the home page with a hard redirect when Continue is pressed', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(PENDING);
      await confirmDeletion(user);

      await user.click(await screen.findByRole('button', { name: /continue/i }));

      expect(window.location.href).toBe('/');
    });

    it('leaves for the home page when the message is dismissed with Escape', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue(PENDING);
      await confirmDeletion(user);
      await screen.findByText('Deletion in progress');

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(window.location.href).toBe('/');
      });
    });

    it('cannot be closed while the request runs, so a pending answer is still shown', async () => {
      const user = userEvent.setup({ delay: null });
      let answer: (value: unknown) => void = () => undefined;
      vi.mocked(apiClient.delete).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      await confirmDeletion(user);
      await screen.findByText(/deleting/i);

      await user.keyboard('{Escape}');
      expect(screen.getByText(/are you absolutely sure/i)).toBeInTheDocument();

      answer(PENDING);
      expect(await screen.findByText('Deletion in progress')).toBeInTheDocument();
    });

    it('redirects at once, with no message, when the deletion finished', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue({ deleted: true, message: 'Account deleted' });

      await confirmDeletion(user);

      await waitFor(() => {
        expect(window.location.href).toBe('/');
      });
      expect(screen.queryByText('Deletion in progress')).not.toBeInTheDocument();
    });

    it('does not treat a body that only mentions pending as one still in progress', async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.delete).mockResolvedValue({ pending: false });

      await confirmDeletion(user);

      await waitFor(() => {
        expect(window.location.href).toBe('/');
      });
      expect(screen.queryByText('Deletion in progress')).not.toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('should handle API errors gracefully', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Failed to delete account', 'DELETE_FAILED')
      );

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButton = screen.getByRole('button', { name: /delete account/i });
      await user.click(actionButton);

      // Assert: API was called (error handling happens internally)
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
      });

      // The dialog stays open while the request runs (t-845), so the error
      // is shown in it rather than lost with a closed dialog.
      expect(await screen.findByText('Failed to delete account')).toBeInTheDocument();
    });

    it('should not redirect when deletion fails', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });

      // Reject with error
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('Network error'));

      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });

      // Act: Confirm and delete
      const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
      await user.type(confirmationInput, 'DELETE');

      const actionButton = screen.getByRole('button', { name: /delete account/i });
      await user.click(actionButton);

      // Wait for API call
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
      });

      // Assert: window.location.href should NOT be changed on error
      expect(window.location.href).toBe('');
    });
  });

  describe('accessibility', () => {
    it('should have autocomplete disabled on confirmation input', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      // Assert
      await waitFor(() => {
        const confirmationInput = screen.getByLabelText(/type.*delete.*to confirm/i);
        expect(confirmationInput).toHaveAttribute('autocomplete', 'off');
      });
    });

    it('should have associated label for confirmation input', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<DeleteAccountForm />);

      const deleteButton = screen.getByRole('button', { name: /^delete account$/i });

      // Act: Open dialog
      await user.click(deleteButton);

      // Assert: Label should be connected to input
      await waitFor(() => {
        expect(screen.getByLabelText(/type.*delete.*to confirm/i)).toBeInTheDocument();
      });
    });
  });
});
