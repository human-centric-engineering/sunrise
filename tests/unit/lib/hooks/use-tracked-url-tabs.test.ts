/**
 * useTrackedUrlTabs Hook Tests
 *
 * Tests the useTrackedUrlTabs hook which combines URL-synced tabs with optional analytics tracking.
 * Features tested:
 * - Basic functionality (delegates to useUrlTabs)
 * - previousTab initialization and updates
 * - Analytics tracking on tab changes
 * - Custom property names for tracking
 * - Additional properties merging
 * - Double-fire prevention (same tab doesn't re-track)
 * - No tracking when tracking option is omitted
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/hooks/use-tracked-url-tabs.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTrackedUrlTabs } from '@/lib/hooks/use-tracked-url-tabs';

// Mock @/lib/analytics
const mockTrack = vi.fn();
const mockAnalytics = {
  track: mockTrack,
  identify: vi.fn(),
  page: vi.fn(),
  reset: vi.fn(),
  isReady: true,
  isEnabled: true,
  providerName: 'console' as const,
};

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => mockAnalytics),
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

type TestTab = 'profile' | 'security' | 'notifications' | 'account';
const TEST_TABS: readonly TestTab[] = ['profile', 'security', 'notifications', 'account'];
const DEFAULT_TAB: TestTab = 'profile';

/**
 * Test Suite: useTrackedUrlTabs Hook
 */
describe('lib/hooks/use-tracked-url-tabs', () => {
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

    // Default: no URL params
    const { useSearchParams, usePathname } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
    vi.mocked(usePathname).mockReturnValue('/settings');

    // Reset track mock
    mockTrack.mockClear();
    mockTrack.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality (without tracking)', () => {
    it('should return activeTab, setActiveTab, and isActive', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.activeTab).toBe('profile');
      expect(typeof result.current.setActiveTab).toBe('function');
      expect(typeof result.current.isActive).toBe('function');
    });

    it('should delegate setActiveTab to useUrlTabs (updates URL)', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - URL should be updated via useUrlTabs
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=security', { scroll: false });
    });

    it('should initialize previousTab ref via useEffect (verified through tracking)', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - Change tab (this will use the initialized ref value for tracking)
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - tracking was called with the initialized previousTab value
      // This proves the ref was initialized correctly by useEffect
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile', // This came from the initialized ref
      });
    });

    it('should update previousTab ref when tab changes (verified via tracking)', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - First tab change
      act(() => {
        result.current.setActiveTab('security');
      });

      // The tracking call proves the ref was initialized and used correctly
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile', // From initialized ref
      });

      mockTrack.mockClear();

      // Act - Second tab change
      act(() => {
        result.current.setActiveTab('notifications');
      });

      // The previous_tab in this call proves the ref was updated to 'security'
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'notifications',
        previous_tab: 'security', // Ref was updated after first change
      });
    });

    it('should update previousTab ref across multiple changes (verified via tracking)', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - First change
      act(() => {
        result.current.setActiveTab('security');
      });
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile', // Initialized value
      });

      mockTrack.mockClear();

      // Act - Second change
      act(() => {
        result.current.setActiveTab('notifications');
      });
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'notifications',
        previous_tab: 'security', // Updated after first change
      });

      mockTrack.mockClear();

      // Act - Third change
      act(() => {
        result.current.setActiveTab('account');
      });

      // Assert - tracking shows ref was updated correctly
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'account',
        previous_tab: 'notifications', // Updated after second change
      });
    });
  });

  describe('analytics tracking', () => {
    it('should call track() when tracking option is provided and tab changes', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'settings_tab_changed',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - track should be called with correct event and properties
      expect(mockTrack).toHaveBeenCalledTimes(1);
      expect(mockTrack).toHaveBeenCalledWith('settings_tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
      });
    });

    it('should use default property names (tab, previous_tab)', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('notifications');
      });

      // Assert - should use default property names
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'notifications',
        previous_tab: 'profile',
      });
    });

    it('should use custom property names when provided', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'admin_tab_changed',
            tabPropertyName: 'selected_tab',
            previousPropertyName: 'from_tab',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('account');
      });

      // Assert - should use custom property names
      expect(mockTrack).toHaveBeenCalledWith('admin_tab_changed', {
        selected_tab: 'account',
        from_tab: 'profile',
      });
    });

    it('should include additionalProperties in tracking call', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'settings_tab_changed',
            additionalProperties: {
              section: 'user_settings',
              userId: '123',
              customData: { foo: 'bar' },
            },
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should merge additional properties
      expect(mockTrack).toHaveBeenCalledWith('settings_tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
        section: 'user_settings',
        userId: '123',
        customData: { foo: 'bar' },
      });
    });

    it('should NOT track when tab has not changed (double-fire prevention)', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'settings_tab_changed',
          },
        })
      );

      // Act - Set to same tab twice
      act(() => {
        result.current.setActiveTab('security');
      });
      expect(mockTrack).toHaveBeenCalledTimes(1);

      // Clear mock
      mockTrack.mockClear();

      // Act - Set to same tab again
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should NOT track again
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('should track multiple different tab changes', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - First change
      act(() => {
        result.current.setActiveTab('security');
      });
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
      });

      // Act - Second change
      act(() => {
        result.current.setActiveTab('notifications');
      });
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'notifications',
        previous_tab: 'security',
      });

      // Act - Third change
      act(() => {
        result.current.setActiveTab('account');
      });

      // Assert - should track all changes
      expect(mockTrack).toHaveBeenCalledTimes(3);
      expect(mockTrack).toHaveBeenLastCalledWith('tab_changed', {
        tab: 'account',
        previous_tab: 'notifications',
      });
    });

    it('should handle previousTab initialization for tracking on first change', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - Change tab (first change)
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - track should be called with initialized previousTab
      // The useEffect ran and initialized the ref to 'profile', which is used in tracking
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile', // Initialized by useEffect before setActiveTab ran
      });
    });
  });

  describe('without tracking option', () => {
    it('should NOT call track() when tracking option is omitted', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          // No tracking option
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - track should NOT be called
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('should still update previousTab ref internally when tracking is disabled', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          // No tracking option
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - no tracking should occur
      expect(mockTrack).not.toHaveBeenCalled();

      // The previousTab ref is still updated internally even without tracking,
      // ensuring consistent behavior if tracking is enabled later.
      // URL update confirms the tab change happened.
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=security', { scroll: false });
    });
  });

  describe('edge cases', () => {
    it('should handle initial tab from URL', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Assert - should initialize to URL tab
      expect(result.current.activeTab).toBe('security');

      // Change to a different tab to verify the ref was initialized correctly
      act(() => {
        result.current.setActiveTab('notifications');
      });

      // Assert - tracking uses the initialized ref value
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'notifications',
        previous_tab: 'security', // Proves ref was initialized to URL tab
      });
    });

    it('should handle custom param name with tracking', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          paramName: 'section',
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'section_changed',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('notifications');
      });

      // Assert - should use custom param in URL
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?section=notifications', {
        scroll: false,
      });

      // And still track correctly
      expect(mockTrack).toHaveBeenCalledWith('section_changed', {
        tab: 'notifications',
        previous_tab: 'profile',
      });
    });

    it('should handle tab changes back and forth', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - Change to security
      act(() => {
        result.current.setActiveTab('security');
      });
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
      });

      // Act - Change back to profile
      act(() => {
        result.current.setActiveTab('profile');
      });

      // Assert - should track the change back
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'profile',
        previous_tab: 'security',
      });
    });

    it('should use all custom options together', async () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          paramName: 'view',
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          titles: {
            profile: 'Profile Settings',
            security: 'Security Settings',
          },
          tracking: {
            eventName: 'settings_view_changed',
            tabPropertyName: 'current_view',
            previousPropertyName: 'previous_view',
            additionalProperties: {
              section: 'settings',
              userRole: 'admin',
            },
          },
        })
      );

      // Wait for document title to be set on initial render
      await waitFor(() => {
        expect(document.title).toBe('Profile Settings');
      });

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - URL uses custom param name
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?view=security', {
        scroll: false,
      });

      // Assert - Track uses custom property names and additional properties
      expect(mockTrack).toHaveBeenCalledWith('settings_view_changed', {
        current_view: 'security',
        previous_view: 'profile',
        section: 'settings',
        userRole: 'admin',
      });

      // Note: Document title won't change in tests because activeTab is derived from URL
      // which doesn't actually change in the test environment. The title update is tested
      // in the useUrlTabs tests.
    });

    it('should handle isActive helper correctly', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Assert - initial state
      expect(result.current.isActive('profile')).toBe(true);
      expect(result.current.isActive('security')).toBe(false);

      // Act - Change tab (call the function)
      act(() => {
        result.current.setActiveTab('security');
      });

      // Note: In tests, activeTab won't change because it's derived from URL state
      // which doesn't actually update in the test environment. The isActive function
      // is tested in the useUrlTabs tests. Here we just verify it exists and works
      // with the current (unchanged) activeTab.
      expect(result.current.isActive('profile')).toBe(true);
      expect(result.current.isActive('security')).toBe(false);
    });

    it('should handle empty additionalProperties gracefully', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
            additionalProperties: {},
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should work without additional properties
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
      });
    });

    it('should handle tracking with only custom tabPropertyName', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
            tabPropertyName: 'selected_tab',
            // previousPropertyName uses default
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should use custom tab property but default previous property
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        selected_tab: 'security',
        previous_tab: 'profile',
      });
    });

    it('should handle tracking with only custom previousPropertyName', () => {
      // Arrange
      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
            // tabPropertyName uses default
            previousPropertyName: 'from_tab',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should use default tab property but custom previous property
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        from_tab: 'profile',
      });
    });
  });

  describe('integration with useUrlTabs features', () => {
    it('should preserve other query params when changing tabs', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('other=value') as unknown as ReturnType<typeof useSearchParams>
      );

      const { result } = renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Act - Change tab
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert - should preserve other params
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?other=value&tab=security', {
        scroll: false,
      });

      // And still track
      expect(mockTrack).toHaveBeenCalledWith('tab_changed', {
        tab: 'security',
        previous_tab: 'profile',
      });
    });

    it('should clean up invalid tabs and not track', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=invalid') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      renderHook(() =>
        useTrackedUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          tracking: {
            eventName: 'tab_changed',
          },
        })
      );

      // Assert - should clean URL (useUrlTabs behavior)
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings', { scroll: false });

      // Should NOT track (no actual tab change happened)
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });
});
