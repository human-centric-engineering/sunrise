/**
 * PreferencesModal Component Tests
 *
 * Tests the PreferencesModal component which handles:
 * - Cookie preferences management dialog
 * - Essential cookies (always enabled, non-toggleable)
 * - Optional cookies (toggleable)
 * - Save/cancel functionality
 * - Dialog accessibility
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/cookie-consent/preferences-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreferencesModal } from '@/components/cookie-consent/preferences-modal';

// Mock the consent module
const mockUpdateConsent = vi.fn();
const mockUseConsent = vi.fn();

vi.mock('@/lib/consent', () => ({
  useConsent: () => mockUseConsent(),
  COOKIE_CATEGORIES: [
    {
      id: 'essential',
      name: 'Essential',
      description:
        'These cookies are necessary for the website to function. They include authentication, security, and user preferences like theme settings.',
      required: true,
    },
    {
      id: 'optional',
      name: 'Analytics & Marketing',
      description:
        'These cookies help us understand how visitors interact with our website and allow us to show relevant advertisements. They may be set by third-party services.',
      required: false,
    },
  ],
}));

/**
 * Test Suite: PreferencesModal Component
 */
describe('components/cookie-consent/preferences-modal', () => {
  const mockOnOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock return value
    mockUseConsent.mockReturnValue({
      consent: {
        essential: true,
        optional: false,
        timestamp: Date.now(),
        version: 1,
      },
      updateConsent: mockUpdateConsent,
    });
  });

  describe('rendering', () => {
    it('should render modal when open prop is true', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert - Modal should be visible with title
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
    });

    it('should NOT render modal when open prop is false', () => {
      // Arrange & Act
      render(<PreferencesModal open={false} onOpenChange={mockOnOpenChange} />);

      // Assert - Modal should not be visible
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
    });

    it('should display modal title and description', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      expect(screen.getByText(/manage your cookie preferences/i)).toBeInTheDocument();
      expect(screen.getByText(/essential cookies cannot be disabled/i)).toBeInTheDocument();
    });

    it('should display Essential cookie category', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      expect(screen.getByText('Essential')).toBeInTheDocument();
      expect(screen.getByText(/these cookies are necessary/i)).toBeInTheDocument();
      expect(screen.getByText('Required')).toBeInTheDocument();
    });

    it('should display Optional cookie category', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      expect(screen.getByText('Analytics & Marketing')).toBeInTheDocument();
      expect(screen.getByText(/these cookies help us understand/i)).toBeInTheDocument();
    });

    it('should display Save and Cancel buttons', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      expect(screen.getByRole('button', { name: /save preferences/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });
  });

  describe('Essential cookie toggle', () => {
    it('should render Essential toggle as checked', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert - Essential toggle should be checked
      const essentialToggle = screen.getByRole('switch', {
        name: /essential cookies \(required\)/i,
      });
      expect(essentialToggle).toBeInTheDocument();
      expect(essentialToggle).toBeChecked();
    });

    it('should render Essential toggle as disabled', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert - Essential toggle should be disabled
      const essentialToggle = screen.getByRole('switch', {
        name: /essential cookies \(required\)/i,
      });
      expect(essentialToggle).toBeDisabled();
    });

    it('should not allow toggling Essential cookies', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const essentialToggle = screen.getByRole('switch', {
        name: /essential cookies \(required\)/i,
      });

      // Act - Try to click (should not work because it's disabled)
      await user.click(essentialToggle);

      // Assert - Should remain checked and disabled
      expect(essentialToggle).toBeChecked();
      expect(essentialToggle).toBeDisabled();
    });
  });

  describe('Optional cookie toggle', () => {
    it('should render Optional toggle as unchecked when consent.optional is false', () => {
      // Arrange
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      // Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      expect(optionalToggle).toBeInTheDocument();
      expect(optionalToggle).not.toBeChecked();
    });

    it('should render Optional toggle as checked when consent.optional is true', () => {
      // Arrange
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: true,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      // Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      expect(optionalToggle).toBeChecked();
    });

    it('should render Optional toggle as enabled (not disabled)', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      expect(optionalToggle).not.toBeDisabled();
    });

    it('should toggle Optional cookies from unchecked to checked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });

      // Act
      await user.click(optionalToggle);

      // Assert
      expect(optionalToggle).toBeChecked();
    });

    it('should toggle Optional cookies from checked to unchecked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: true,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });

      // Act
      await user.click(optionalToggle);

      // Assert
      expect(optionalToggle).not.toBeChecked();
    });
  });

  describe('Save Preferences functionality', () => {
    it('should call updateConsent with false when saving with Optional disabled', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Act
      await user.click(saveButton);

      // Assert
      expect(mockUpdateConsent).toHaveBeenCalledWith(false);
      expect(mockUpdateConsent).toHaveBeenCalledTimes(1);
    });

    it('should call updateConsent with true when saving with Optional enabled', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Act - Toggle to enabled, then save
      await user.click(optionalToggle);
      await user.click(saveButton);

      // Assert
      expect(mockUpdateConsent).toHaveBeenCalledWith(true);
      expect(mockUpdateConsent).toHaveBeenCalledTimes(1);
    });

    it('should close modal after saving', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Act
      await user.click(saveButton);

      // Assert
      await waitFor(() => {
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should call updateConsent before closing modal', async () => {
      // Arrange
      const user = userEvent.setup();
      const callOrder: string[] = [];

      mockUpdateConsent.mockImplementation(() => {
        callOrder.push('updateConsent');
      });

      const onOpenChange = vi.fn((open: boolean) => {
        if (!open) {
          callOrder.push('onOpenChange');
        }
      });

      render(<PreferencesModal open={true} onOpenChange={onOpenChange} />);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });

      // Act
      await user.click(saveButton);

      // Assert - updateConsent should be called before onOpenChange
      await waitFor(() => {
        expect(callOrder).toEqual(['updateConsent', 'onOpenChange']);
      });
    });
  });

  describe('Cancel functionality', () => {
    it('should close modal when Cancel button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const cancelButton = screen.getByRole('button', { name: /cancel/i });

      // Act
      await user.click(cancelButton);

      // Assert
      await waitFor(() => {
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should NOT call updateConsent when Cancel is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const cancelButton = screen.getByRole('button', { name: /cancel/i });

      // Act
      await user.click(cancelButton);

      // Assert
      await waitFor(() => {
        expect(mockUpdateConsent).not.toHaveBeenCalled();
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should NOT save changes when Cancel is clicked after toggling', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      const cancelButton = screen.getByRole('button', { name: /cancel/i });

      // Act - Toggle, then cancel
      await user.click(optionalToggle);
      await user.click(cancelButton);

      // Assert - Changes should not be saved
      expect(mockUpdateConsent).not.toHaveBeenCalled();
      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('state reset on modal open', () => {
    it('should reset toggle state when modal reopens', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseConsent.mockReturnValue({
        consent: {
          essential: true,
          optional: false,
          timestamp: Date.now(),
          version: 1,
        },
        updateConsent: mockUpdateConsent,
      });

      const { rerender } = render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Act 1: Toggle optional to enabled
      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      await user.click(optionalToggle);
      expect(optionalToggle).toBeChecked();

      // Act 2: Close modal without saving
      rerender(<PreferencesModal open={false} onOpenChange={mockOnOpenChange} />);

      // Act 3: Reopen modal
      rerender(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert: Toggle should be reset to initial state (unchecked)
      const resetToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      expect(resetToggle).not.toBeChecked();
    });
  });

  describe('accessibility', () => {
    it('should have dialog role', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should have accessible title', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert - Title should be visible and associated with dialog
      const dialog = screen.getByRole('dialog');
      const title = screen.getByText('Cookie Preferences');

      expect(dialog).toBeInTheDocument();
      expect(title).toBeInTheDocument();
    });

    it('should have accessible description', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert - Description should be visible
      expect(screen.getByText(/manage your cookie preferences/i)).toBeInTheDocument();
    });

    it('should have aria-label on Essential toggle', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const essentialToggle = screen.getByRole('switch', {
        name: /essential cookies \(required\)/i,
      });
      expect(essentialToggle).toHaveAttribute('aria-label');
    });

    it('should have aria-label on Optional toggle', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const optionalToggle = screen.getByRole('switch', {
        name: /analytics & marketing cookies/i,
      });
      expect(optionalToggle).toHaveAttribute('aria-label');
    });

    it('should have proper button types', () => {
      // Arrange & Act
      render(<PreferencesModal open={true} onOpenChange={mockOnOpenChange} />);

      // Assert
      const saveButton = screen.getByRole('button', { name: /save preferences/i });
      const cancelButton = screen.getByRole('button', { name: /cancel/i });

      expect(saveButton).toHaveAttribute('type', 'button');
      expect(cancelButton).toHaveAttribute('type', 'button');
    });
  });
});
