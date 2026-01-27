/**
 * SettingsTabs Component Tests
 *
 * Tests the SettingsTabs component which renders settings tabs with URL persistence.
 * Features tested:
 * - Tab rendering and switching
 * - URL sync via useUrlTabs hook
 * - Conditional rendering (password form vs OAuth message)
 * - User data display
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/settings/settings-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import type { UserPreferences } from '@/types';

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

// Mock analytics events
const mockTrackTabChanged = vi.fn();
vi.mock('@/lib/analytics/events', () => ({
  useSettingsAnalytics: vi.fn(() => ({
    trackTabChanged: mockTrackTabChanged,
  })),
}));

// Mock form components to simplify testing
vi.mock('@/components/forms/profile-form', () => ({
  ProfileForm: vi.fn(() => <div data-testid="profile-form">ProfileForm</div>),
}));

vi.mock('@/components/forms/password-form', () => ({
  PasswordForm: vi.fn(() => <div data-testid="password-form">PasswordForm</div>),
}));

vi.mock('@/components/forms/preferences-form', () => ({
  PreferencesForm: vi.fn(() => <div data-testid="preferences-form">PreferencesForm</div>),
}));

vi.mock('@/components/forms/delete-account-form', () => ({
  DeleteAccountForm: vi.fn(() => <div data-testid="delete-account-form">DeleteAccountForm</div>),
}));

// Test fixtures
const mockUser = {
  name: 'Test User',
  email: 'test@example.com',
  bio: 'A test bio',
  phone: '+1234567890',
  timezone: 'America/New_York',
  location: 'New York',
  image: 'https://example.com/avatar.jpg',
  emailVerified: true,
  role: 'USER',
  createdAt: new Date('2024-01-15'),
};

const mockPreferences: UserPreferences = {
  email: {
    marketing: false,
    productUpdates: true,
    securityAlerts: true,
  },
};

const defaultProps = {
  user: mockUser,
  preferences: mockPreferences,
  hasPasswordAccount: true,
  oauthProviders: [] as string[],
  initials: 'TU',
};

/**
 * Test Suite: SettingsTabs Component
 */
describe('components/settings/settings-tabs', () => {
  let mockRouter: { replace: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = { replace: vi.fn() };
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: mockRouter.replace,
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Default: no URL params (profile tab)
    const { useSearchParams, usePathname } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
    vi.mocked(usePathname).mockReturnValue('/settings');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render all four tab triggers', () => {
      // Arrange & Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByRole('tab', { name: /profile/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /security/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /notifications/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /account/i })).toBeInTheDocument();
    });

    it('should render profile tab content by default', () => {
      // Arrange & Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByTestId('profile-form')).toBeInTheDocument();
      expect(screen.getByText('TU')).toBeInTheDocument(); // Avatar initials
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    it('should render avatar component with image prop', () => {
      // Arrange & Act
      // Note: AvatarImage from Radix only shows after image loads, which doesn't happen in jsdom
      // We test that the component renders correctly with the image prop
      render(<SettingsTabs {...defaultProps} />);

      // Assert - avatar container exists and fallback is available
      // The actual image rendering is handled by Radix UI's Avatar component
      const avatarContainer = screen.getByText('TU').closest('span');
      expect(avatarContainer).toBeInTheDocument();
    });

    it('should show avatar fallback initials', () => {
      // Arrange
      const propsWithoutImage = {
        ...defaultProps,
        user: { ...mockUser, image: null },
      };

      // Act
      render(<SettingsTabs {...propsWithoutImage} />);

      // Assert
      expect(screen.getByText('TU')).toBeInTheDocument();
    });
  });

  describe('tab switching', () => {
    it('should update URL when clicking security tab', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsTabs {...defaultProps} />);

      // Act
      await user.click(screen.getByRole('tab', { name: /security/i }));

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=security', { scroll: false });
    });

    it('should update URL when clicking notifications tab', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsTabs {...defaultProps} />);

      // Act
      await user.click(screen.getByRole('tab', { name: /notifications/i }));

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=notifications', {
        scroll: false,
      });
    });

    it('should update URL when clicking account tab', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsTabs {...defaultProps} />);

      // Act
      await user.click(screen.getByRole('tab', { name: /account/i }));

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=account', { scroll: false });
    });

    it('should remove tab param when clicking profile tab (default)', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      const user = userEvent.setup();
      render(<SettingsTabs {...defaultProps} />);

      // Act
      await user.click(screen.getByRole('tab', { name: /profile/i }));

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings', { scroll: false });
    });
  });

  describe('security tab', () => {
    it('should show password form when user has password account', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} hasPasswordAccount={true} />);

      // Assert
      expect(screen.getByTestId('password-form')).toBeInTheDocument();
    });

    it('should show OAuth message when user has no password account', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(
        <SettingsTabs
          {...defaultProps}
          hasPasswordAccount={false}
          oauthProviders={['Google', 'GitHub']}
        />
      );

      // Assert
      expect(screen.queryByTestId('password-form')).not.toBeInTheDocument();
      expect(screen.getByText(/Google, GitHub/)).toBeInTheDocument();
      expect(screen.getByText(/password settings are not available/i)).toBeInTheDocument();
    });

    it('should show fallback text when no OAuth providers specified', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} hasPasswordAccount={false} oauthProviders={[]} />);

      // Assert
      expect(screen.getByText(/an external provider/)).toBeInTheDocument();
    });
  });

  describe('account tab', () => {
    it('should display user email', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByText('test@example.com')).toBeInTheDocument();
    });

    it('should display email verified status as Yes', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByText('Yes')).toBeInTheDocument();
    });

    it('should display email verified status as No', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} user={{ ...mockUser, emailVerified: false }} />);

      // Assert
      expect(screen.getByText('No')).toBeInTheDocument();
    });

    it('should display user role', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByText('USER')).toBeInTheDocument();
    });

    it('should display formatted member since date', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByText('January 15, 2024')).toBeInTheDocument();
    });

    it('should render delete account form', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByTestId('delete-account-form')).toBeInTheDocument();
    });

    it('should show Danger Zone heading', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    });
  });

  describe('notifications tab', () => {
    it('should render preferences form', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=notifications') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByTestId('preferences-form')).toBeInTheDocument();
    });
  });

  describe('URL state persistence', () => {
    it('should render security tab when URL has tab=security', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert
      expect(screen.getByRole('tab', { name: /security/i })).toHaveAttribute(
        'data-state',
        'active'
      );
    });

    it('should render profile tab and clean URL when tab value is invalid', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=invalid') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SettingsTabs {...defaultProps} />);

      // Assert - shows default tab and cleans up URL
      expect(screen.getByRole('tab', { name: /profile/i })).toHaveAttribute('data-state', 'active');
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings', { scroll: false });
    });
  });

  describe('analytics tracking', () => {
    it('should track tab change with correct previous_tab when switching from default tab', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SettingsTabs {...defaultProps} />);

      // Clear any calls from initial render
      mockTrackTabChanged.mockClear();

      // Act - User lands on profile (default) and clicks security tab
      await user.click(screen.getByRole('tab', { name: /security/i }));

      // Assert - trackTabChanged should be called with previous_tab='profile', not undefined
      expect(mockTrackTabChanged).toHaveBeenCalledWith({
        tab: 'security',
        previous_tab: 'profile',
      });
      expect(mockTrackTabChanged).toHaveBeenCalledTimes(1);
    });
  });
});
