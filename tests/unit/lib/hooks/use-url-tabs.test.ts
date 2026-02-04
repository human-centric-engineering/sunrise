/**
 * useUrlTabs Hook Tests
 *
 * Tests the useUrlTabs hook which syncs tab state with URL query parameters.
 * Features tested:
 * - Reading initial tab from URL
 * - Validating against allowed tabs
 * - Falling back to default tab
 * - Updating URL when tab changes
 * - isActive helper function
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/hooks/use-url-tabs.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';

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
 * Test Suite: useUrlTabs Hook
 */
describe('lib/hooks/use-url-tabs', () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('activeTab', () => {
    it('should return default tab when URL has no tab param', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.activeTab).toBe('profile');
    });

    it('should return tab from URL when valid', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.activeTab).toBe('security');
    });

    it('should return default tab and clean URL when tab value is invalid', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=invalid') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert - returns default tab and cleans up URL
      expect(result.current.activeTab).toBe('profile');
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings', { scroll: false });
    });

    it('should use custom param name when provided', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('section=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          paramName: 'section',
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.activeTab).toBe('security');
    });
  });

  describe('setActiveTab', () => {
    it('should update URL with tab param when setting non-default tab', () => {
      // Arrange
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?tab=security', { scroll: false });
    });

    it('should remove tab param when setting default tab', () => {
      // Arrange
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        result.current.setActiveTab('profile');
      });

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings', { scroll: false });
    });

    it('should not update URL for invalid tab value', () => {
      // Arrange
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        // @ts-expect-error - Testing invalid tab value
        result.current.setActiveTab('invalid');
      });

      // Assert
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('should preserve existing query params when updating tab', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('other=value') as unknown as ReturnType<typeof useSearchParams>
      );

      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        result.current.setActiveTab('security');
      });

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?other=value&tab=security', {
        scroll: false,
      });
    });

    it('should use custom param name when updating URL', () => {
      // Arrange
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          paramName: 'section',
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Act
      act(() => {
        result.current.setActiveTab('notifications');
      });

      // Assert
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?section=notifications', {
        scroll: false,
      });
    });
  });

  describe('isActive', () => {
    it('should return true for active tab', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.isActive('profile')).toBe(true);
    });

    it('should return false for inactive tab', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.isActive('security')).toBe(false);
    });

    it('should update after tab change', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=account') as unknown as ReturnType<typeof useSearchParams>
      );

      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.isActive('account')).toBe(true);
      expect(result.current.isActive('profile')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty allowed tabs array gracefully', () => {
      // Arrange & Act
      const { result } = renderHook(() =>
        useUrlTabs({
          defaultTab: 'default',
          allowedTabs: [],
        })
      );

      // Assert - should return default tab since nothing is valid
      expect(result.current.activeTab).toBe('default');
    });

    it('should handle URL with multiple query params', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('foo=bar&tab=notifications&baz=qux') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      const { result } = renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert
      expect(result.current.activeTab).toBe('notifications');
    });

    it('should preserve other query params when cleaning up invalid tab', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('foo=bar&tab=invalid&baz=qux') as unknown as ReturnType<
          typeof useSearchParams
        >
      );

      // Act
      renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert - removes invalid tab but keeps other params
      expect(mockRouter.replace).toHaveBeenCalledWith('/settings?foo=bar&baz=qux', {
        scroll: false,
      });
    });

    it('should not call router.replace when tab is valid', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert - no cleanup needed for valid tab
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });
  });

  describe('document title', () => {
    it('should update document.title when titles are provided', () => {
      // Arrange
      const titles = {
        profile: 'Profile - Settings',
        security: 'Security - Settings',
      };

      // Act
      renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          titles,
        })
      );

      // Assert
      expect(document.title).toBe('Profile - Settings');
    });

    it('should update document.title when tab changes', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=security') as unknown as ReturnType<typeof useSearchParams>
      );

      const titles = {
        profile: 'Profile - Settings',
        security: 'Security - Settings',
      };

      // Act
      renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
          titles,
        })
      );

      // Assert
      expect(document.title).toBe('Security - Settings');
    });

    it('should not update document.title when titles are not provided', () => {
      // Arrange
      const originalTitle = document.title;

      // Act
      renderHook(() =>
        useUrlTabs<TestTab>({
          defaultTab: DEFAULT_TAB,
          allowedTabs: TEST_TABS,
        })
      );

      // Assert - title unchanged
      expect(document.title).toBe(originalTitle);
    });
  });
});
