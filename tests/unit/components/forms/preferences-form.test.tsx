/**
 * PreferencesForm Component Tests
 *
 * Tests the PreferencesForm component which handles:
 * - Email notification preferences (marketing, product updates, security alerts)
 * - Security alerts always enabled (cannot be disabled)
 * - API client integration
 * - Success and error states
 * - Router refresh on update
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/preferences-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreferencesForm } from '@/components/forms/preferences-form';
import type { UserPreferences } from '@/types';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    patch: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: unknown;

    constructor(message: string, code = 'UNKNOWN_ERROR', details?: unknown) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.details = details;
    }
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/settings/preferences'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: PreferencesForm Component
 */
describe('components/forms/preferences-form', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

  const mockPreferences: UserPreferences = {
    email: {
      marketing: false,
      productUpdates: true,
      securityAlerts: true,
    },
  };

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render all email preference switches', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      expect(screen.getByLabelText(/marketing emails/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/product updates/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/security alerts/i)).toBeInTheDocument();
    });

    it('should render switches with correct initial states', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });
      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });

      expect(marketingSwitch).not.toBeChecked();
      expect(productUpdatesSwitch).toBeChecked();
      expect(securityAlertsSwitch).toBeChecked();
    });

    it('should render security alerts switch as disabled', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });
      expect(securityAlertsSwitch).toBeDisabled();
    });

    it('should display security icon for security alerts', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      // ShieldCheck icon is rendered for security alerts
      const securitySection = screen.getByLabelText(/security alerts/i).closest('div');
      expect(securitySection).toBeInTheDocument();
    });

    it('should show security alerts warning message', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      expect(
        screen.getByText(/security alerts cannot be disabled for your protection/i)
      ).toBeInTheDocument();
    });

    it('should render save preferences button', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });
      expect(saveButton).toBeInTheDocument();
    });

    it('should render descriptions for each preference', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      expect(
        screen.getByText(/receive newsletters, promotions, and product news/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/get notified about new features and improvements/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/important security notifications about your account/i)
      ).toBeInTheDocument();
    });

    it('should not show error or success messages initially', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/successfully/i)).not.toBeInTheDocument();
    });
  });

  describe('switch interactions', () => {
    it('should toggle marketing emails switch', async () => {
      const user = userEvent.setup({ delay: null });
      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });

      expect(marketingSwitch).not.toBeChecked();

      await user.click(marketingSwitch);

      expect(marketingSwitch).toBeChecked();
    });

    it('should toggle product updates switch', async () => {
      const user = userEvent.setup({ delay: null });
      render(<PreferencesForm preferences={mockPreferences} />);

      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });

      expect(productUpdatesSwitch).toBeChecked();

      await user.click(productUpdatesSwitch);

      expect(productUpdatesSwitch).not.toBeChecked();
    });

    it('should not toggle security alerts switch (always disabled)', async () => {
      const user = userEvent.setup({ delay: null });
      render(<PreferencesForm preferences={mockPreferences} />);

      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });

      expect(securityAlertsSwitch).toBeChecked();
      expect(securityAlertsSwitch).toBeDisabled();

      // Attempt to click (should not work)
      await user.click(securityAlertsSwitch);

      // Should still be checked and disabled
      expect(securityAlertsSwitch).toBeChecked();
      expect(securityAlertsSwitch).toBeDisabled();
    });

    it('should allow multiple switches to be toggled before saving', async () => {
      const user = userEvent.setup({ delay: null });
      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });

      // Toggle both switches
      await user.click(marketingSwitch);
      await user.click(productUpdatesSwitch);

      expect(marketingSwitch).toBeChecked();
      expect(productUpdatesSwitch).not.toBeChecked();
    });
  });

  describe('form submission', () => {
    it('should call apiClient.patch with updated preferences', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Toggle marketing and save
      await user.click(marketingSwitch);
      await user.click(saveButton);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/me/preferences', {
          body: {
            email: {
              marketing: true, // Changed from false
              productUpdates: true,
              securityAlerts: true,
            },
          },
        });
      });
    });

    it('should always send securityAlerts as true', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          '/api/v1/users/me/preferences',
          expect.objectContaining({
            body: expect.objectContaining({
              email: expect.objectContaining({
                securityAlerts: true,
              }),
            }),
          })
        );
      });
    });

    it('should show loading state during submission', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      // Make patch hang
      vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument();
      });
    });

    it('should disable switches during submission', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));

      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });
      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(marketingSwitch).toBeDisabled();
        expect(productUpdatesSwitch).toBeDisabled();
      });
    });

    it('should show success message on successful update', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/preferences saved successfully/i)).toBeInTheDocument();
      });
    });

    it('should refresh router on successful update', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(mockRouter.refresh).toHaveBeenCalled();
      });
    });

    it('should hide success message after 3 seconds', async () => {
      // Use fake timers for this specific test
      vi.useFakeTimers();
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Use fireEvent instead of userEvent for fake timer compatibility
      await act(async () => {
        fireEvent.click(saveButton);
        // Flush promises to let the API call resolve
        await Promise.resolve();
      });

      // Success message should be visible
      expect(screen.getByText(/preferences saved successfully/i)).toBeInTheDocument();

      // Advance time by 3 seconds
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // Success message should be gone
      expect(screen.queryByText(/preferences saved successfully/i)).not.toBeInTheDocument();

      // Restore real timers
      vi.useRealTimers();
    });

    it('should save without toggling any switches', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Click save without changing anything
      await user.click(saveButton);

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/me/preferences', {
          body: {
            email: {
              marketing: false,
              productUpdates: true,
              securityAlerts: true,
            },
          },
        });
      });
    });
  });

  describe('error handling', () => {
    it('should display error message on API client error', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update preferences', 'UPDATE_FAILED')
      );

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to update preferences/i)).toBeInTheDocument();
      });
    });

    it('should display generic error on unexpected error', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(new Error('Network error'));

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/an unexpected error occurred/i)).toBeInTheDocument();
      });
    });

    it('should re-enable switches after error', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update preferences', 'SERVER_ERROR')
      );

      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });
      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      // Assert - Switches should be re-enabled after error (except security alerts)
      await waitFor(() => {
        expect(screen.getByText(/failed to update preferences/i)).toBeInTheDocument();
      });
      expect(marketingSwitch).not.toBeDisabled();
      expect(productUpdatesSwitch).not.toBeDisabled();
      expect(saveButton).not.toBeDisabled();
    });

    it('should clear error when resubmitting', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValueOnce(
        new APIClientError('Failed to update', 'SERVER_ERROR')
      );

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Act - First submission fails
      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to update/i)).toBeInTheDocument();
      });

      // Second submission succeeds
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockPreferences,
      });

      await user.click(saveButton);

      // Assert - Error should be cleared
      await waitFor(() => {
        expect(screen.queryByText(/failed to update/i)).not.toBeInTheDocument();
        expect(screen.getByText(/preferences saved successfully/i)).toBeInTheDocument();
      });
    });

    it('should not show success message on error', async () => {
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update preferences', 'SERVER_ERROR')
      );

      render(<PreferencesForm preferences={mockPreferences} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.queryByText(/preferences saved successfully/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('preferences state management', () => {
    it('should handle all preferences disabled', () => {
      const allDisabledPreferences: UserPreferences = {
        email: {
          marketing: false,
          productUpdates: false,
          securityAlerts: true,
        },
      };

      render(<PreferencesForm preferences={allDisabledPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });
      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });

      expect(marketingSwitch).not.toBeChecked();
      expect(productUpdatesSwitch).not.toBeChecked();
      expect(securityAlertsSwitch).toBeChecked();
    });

    it('should handle all preferences enabled', () => {
      const allEnabledPreferences: UserPreferences = {
        email: {
          marketing: true,
          productUpdates: true,
          securityAlerts: true,
        },
      };

      render(<PreferencesForm preferences={allEnabledPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });
      const productUpdatesSwitch = screen.getByRole('switch', { name: /product updates/i });
      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });

      expect(marketingSwitch).toBeChecked();
      expect(productUpdatesSwitch).toBeChecked();
      expect(securityAlertsSwitch).toBeChecked();
    });

    it('should maintain local state across multiple toggles', async () => {
      const user = userEvent.setup({ delay: null });
      render(<PreferencesForm preferences={mockPreferences} />);

      const marketingSwitch = screen.getByRole('switch', { name: /marketing/i });

      expect(marketingSwitch).not.toBeChecked();

      // Toggle on
      await user.click(marketingSwitch);
      expect(marketingSwitch).toBeChecked();

      // Toggle off
      await user.click(marketingSwitch);
      expect(marketingSwitch).not.toBeChecked();

      // Toggle on again
      await user.click(marketingSwitch);
      expect(marketingSwitch).toBeChecked();
    });
  });

  describe('accessibility', () => {
    it('should have associated labels for all switches', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      expect(screen.getByLabelText(/marketing emails/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/product updates/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/security alerts/i)).toBeInTheDocument();
    });

    it('should have aria-label for disabled security alerts switch', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      const securityAlertsSwitch = screen.getByRole('switch', { name: /security alerts/i });
      expect(securityAlertsSwitch).toHaveAttribute(
        'aria-label',
        'Security alerts are always enabled'
      );
    });

    it('should have descriptive text for each preference', () => {
      render(<PreferencesForm preferences={mockPreferences} />);

      // Each switch should have a description
      const descriptions = screen.getAllByText(/receive|get notified|important/i);
      expect(descriptions.length).toBeGreaterThanOrEqual(3);
    });
  });
});
