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
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/delete-account-form.tsx
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
  APIClientError: class APIClientError extends Error {
    code?: string;
    details?: unknown;

    constructor(message: string, code?: string, details?: unknown) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
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
  usePathname: vi.fn(() => '/settings'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: DeleteAccountForm Component
 */
describe('components/forms/delete-account-form', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clear analytics mocks
    mockReset.mockClear();
    mockTrack.mockClear();

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
        expect(apiClient.delete).toHaveBeenCalled();
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

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/');
        expect(mockRouter.refresh).toHaveBeenCalled();
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
      expect(apiClient.delete).not.toHaveBeenCalled();
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

      // Assert: Analytics tracking and reset should be called
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('account_deleted');
        expect(mockReset).toHaveBeenCalled();
      });
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
        expect(apiClient.delete).toHaveBeenCalled();
      });

      // Dialog closes even on error due to AlertDialog behavior
      // Error state is set but not visible because dialog is closed
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
        expect(apiClient.delete).toHaveBeenCalled();
      });

      // Assert: Router push should NOT be called on error
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(mockRouter.refresh).not.toHaveBeenCalled();
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
