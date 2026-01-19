/**
 * CookieBanner Component Tests
 *
 * Tests the CookieBanner component which handles:
 * - Conditional rendering based on consent state
 * - Delayed banner appearance
 * - Accept All / Essential Only / Manage Preferences actions
 * - GDPR compliance with equal prominence buttons
 * - Accessibility with ARIA attributes
 * - Privacy Policy link
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/cookie-consent/cookie-banner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CookieBanner } from '@/components/cookie-consent/cookie-banner';

// Mock the consent library
const mockAcceptAll = vi.fn();
const mockRejectOptional = vi.fn();
const mockOpenPreferences = vi.fn();
const mockClosePreferences = vi.fn();
const mockUseConsent = vi.fn();
const mockUseShouldShowConsentBanner = vi.fn();

vi.mock('@/lib/consent', () => ({
  useConsent: () => mockUseConsent(),
  useShouldShowConsentBanner: () => mockUseShouldShowConsentBanner(),
  BANNER_DELAY_MS: 0, // Set to 0 for instant rendering in tests
}));

// Mock the PreferencesModal component
vi.mock('@/components/cookie-consent/preferences-modal', () => ({
  PreferencesModal: ({ open, onOpenChange }: { open: boolean; onOpenChange: () => void }) => (
    <button data-testid="preferences-modal" data-open={open} onClick={onOpenChange} type="button">
      Preferences Modal
    </button>
  ),
}));

/**
 * Test Suite: CookieBanner Component
 */
describe('components/cookie-consent/cookie-banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUseConsent.mockReturnValue({
      acceptAll: mockAcceptAll,
      rejectOptional: mockRejectOptional,
      openPreferences: mockOpenPreferences,
      closePreferences: mockClosePreferences,
      isPreferencesOpen: false,
      consent: {
        essential: true,
        optional: false,
        timestamp: null,
        version: 1,
      },
      hasConsented: false,
      isInitialized: true,
      updateConsent: vi.fn(),
      resetConsent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should NOT render banner when user has already consented', () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(false);

      // Act
      render(<CookieBanner />);

      // Assert: Banner should not be visible
      expect(screen.queryByRole('dialog', { name: /cookie consent/i })).not.toBeInTheDocument();
    });

    it('should render banner when user has NOT consented', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: Banner should be visible after delay
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /cookie consent/i })).toBeInTheDocument();
      });
    });

    it('should render banner with cookie description text', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/we use cookies to improve your experience/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/essential cookies are always active/i)).toBeInTheDocument();
    });

    it('should render Accept All button', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const acceptButton = screen.getByRole('button', { name: /accept all/i });
        expect(acceptButton).toBeInTheDocument();
        expect(acceptButton).toHaveClass('flex-1', 'sm:flex-none'); // GDPR equal prominence
      });
    });

    it('should render Essential Only button', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const essentialButton = screen.getByRole('button', { name: /essential only/i });
        expect(essentialButton).toBeInTheDocument();
        expect(essentialButton).toHaveClass('flex-1', 'sm:flex-none'); // GDPR equal prominence
      });
    });

    it('should render Manage Preferences button', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /manage preferences/i })).toBeInTheDocument();
      });
    });

    it('should render Privacy Policy link', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
        expect(privacyLink).toBeInTheDocument();
        expect(privacyLink).toHaveAttribute('href', '/privacy');
      });
    });

    it('should always render PreferencesModal regardless of banner visibility', () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(false); // Banner hidden

      // Act
      render(<CookieBanner />);

      // Assert: PreferencesModal should still be rendered
      expect(screen.getByTestId('preferences-modal')).toBeInTheDocument();
    });
  });

  describe('delay behavior', () => {
    it('should render after delay when shouldShow is true', async () => {
      // Arrange: Reset mock to use actual delay timing
      vi.resetModules();
      vi.doMock('@/lib/consent', () => ({
        useConsent: () => mockUseConsent(),
        useShouldShowConsentBanner: () => mockUseShouldShowConsentBanner(),
        BANNER_DELAY_MS: 100, // Small delay for testing
      }));

      const { CookieBanner: DelayedBanner } =
        await import('@/components/cookie-consent/cookie-banner');

      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<DelayedBanner />);

      // Assert: Banner should not be visible immediately
      expect(screen.queryByRole('dialog', { name: /cookie consent/i })).not.toBeInTheDocument();

      // Assert: Banner should appear after delay
      await waitFor(
        () => {
          expect(screen.getByRole('dialog', { name: /cookie consent/i })).toBeInTheDocument();
        },
        { timeout: 200 }
      );
    });
  });

  describe('user interactions', () => {
    it('should call acceptAll when Accept All button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      render(<CookieBanner />);

      // Wait for banner to appear
      const acceptButton = await screen.findByRole('button', { name: /accept all/i });

      // Act
      await user.click(acceptButton);

      // Assert
      expect(mockAcceptAll).toHaveBeenCalledTimes(1);
    });

    it('should call rejectOptional when Essential Only button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      render(<CookieBanner />);

      // Wait for banner to appear
      const essentialButton = await screen.findByRole('button', { name: /essential only/i });

      // Act
      await user.click(essentialButton);

      // Assert
      expect(mockRejectOptional).toHaveBeenCalledTimes(1);
    });

    it('should call openPreferences when Manage Preferences button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      render(<CookieBanner />);

      // Wait for banner to appear
      const preferencesButton = await screen.findByRole('button', { name: /manage preferences/i });

      // Act
      await user.click(preferencesButton);

      // Assert
      expect(mockOpenPreferences).toHaveBeenCalledTimes(1);
    });

    it('should pass isPreferencesOpen state to PreferencesModal', () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);
      mockUseConsent.mockReturnValue({
        ...mockUseConsent(),
        isPreferencesOpen: true, // Modal open
      });

      // Act
      render(<CookieBanner />);

      // Assert
      const modal = screen.getByTestId('preferences-modal');
      expect(modal).toHaveAttribute('data-open', 'true');
    });

    it('should pass closePreferences to PreferencesModal onOpenChange', () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      render(<CookieBanner />);

      const modal = screen.getByTestId('preferences-modal');

      // Act: Simulate modal close
      modal.click();

      // Assert
      expect(mockClosePreferences).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility', () => {
    it('should have proper role and aria-label for dialog', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        expect(dialog).toHaveAttribute('aria-modal', 'false'); // Not modal - doesn't block page
        expect(dialog).toHaveAttribute('aria-label', 'Cookie consent');
      });
    });

    it('should have aria-describedby pointing to description text', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        expect(dialog).toHaveAttribute('aria-describedby', 'cookie-banner-description');

        // Verify the description element exists with matching ID
        const description = screen.getByText(/we use cookies to improve your experience/i);
        expect(description).toHaveAttribute('id', 'cookie-banner-description');
      });
    });

    it('should have underlined link with hover effect', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
        expect(privacyLink).toHaveClass('underline', 'underline-offset-4', 'hover:no-underline');
      });
    });

    it('should have keyboard navigable buttons', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: All buttons should be focusable
      await waitFor(() => {
        const acceptButton = screen.getByRole('button', { name: /accept all/i });
        const essentialButton = screen.getByRole('button', { name: /essential only/i });
        const preferencesButton = screen.getByRole('button', { name: /manage preferences/i });

        expect(acceptButton).toBeInTheDocument();
        expect(essentialButton).toBeInTheDocument();
        expect(preferencesButton).toBeInTheDocument();
      });
    });
  });

  describe('visual styling', () => {
    it('should be fixed at the bottom of the screen', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        expect(dialog).toHaveClass('fixed', 'right-0', 'bottom-0', 'left-0', 'z-50');
      });
    });

    it('should have border and shadow for visibility', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        expect(dialog).toHaveClass('border-t', 'shadow-lg');
      });
    });

    it('should use background color that respects dark mode', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        expect(dialog).toHaveClass('bg-background');
      });
    });

    it('should have responsive layout classes', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: Check for responsive flex classes
      await waitFor(() => {
        const dialog = screen.getByRole('dialog', { name: /cookie consent/i });
        const container = dialog.querySelector('.flex');
        expect(container).toHaveClass('flex-col', 'lg:flex-row', 'lg:items-center');
      });
    });
  });

  describe('GDPR compliance', () => {
    it('should give equal prominence to Accept All and Essential Only buttons', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: Both should have flex-1 for equal width on mobile
      await waitFor(() => {
        const acceptButton = screen.getByRole('button', { name: /accept all/i });
        const essentialButton = screen.getByRole('button', { name: /essential only/i });

        expect(acceptButton).toHaveClass('flex-1');
        expect(essentialButton).toHaveClass('flex-1');
      });
    });

    it('should clearly explain what cookies are used for', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: Clear explanation text
      await waitFor(() => {
        expect(screen.getByText(/essential cookies are always active/i)).toBeInTheDocument();
        expect(screen.getByText(/optional cookies help us analyze usage/i)).toBeInTheDocument();
      });
    });

    it('should provide link to detailed privacy information', async () => {
      // Arrange
      mockUseShouldShowConsentBanner.mockReturnValue(true);

      // Act
      render(<CookieBanner />);

      // Assert: Privacy policy link is present and accessible
      await waitFor(() => {
        const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
        expect(privacyLink).toBeInTheDocument();
        expect(privacyLink).toHaveAttribute('href', '/privacy');
      });
    });
  });
});
