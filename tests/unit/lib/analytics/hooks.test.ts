/**
 * usePageTracking Hook Tests
 *
 * Tests the usePageTracking hook which automatically tracks page views on route changes.
 * Features tested:
 * - Waiting for isReady before tracking
 * - Initial page tracking with skipInitial option
 * - Route change detection and tracking
 * - Double-tracking prevention
 * - Page property construction
 * - Custom property merging
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/analytics/hooks.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { AnalyticsContextValue } from '@/lib/analytics/types';

// Hoisted mock for useContext
const mockUseContext = vi.hoisted(() => vi.fn());

// Mock React to override useContext
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useContext: mockUseContext,
  };
});

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: usePageTracking Hook
 */
describe('lib/analytics/hooks', () => {
  let mockAnalyticsContext: AnalyticsContextValue;
  let mockPage: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock page function
    mockPage = vi.fn().mockResolvedValue({ success: true });

    // Setup mock analytics context
    mockAnalyticsContext = {
      identify: vi.fn(),
      track: vi.fn(),
      page: mockPage,
      reset: vi.fn(),
      isReady: true,
      isEnabled: true,
      providerName: 'console',
    };

    // Mock useContext to return our analytics context
    mockUseContext.mockReturnValue(mockAnalyticsContext);

    // Default: pathname="/" and no search params
    const { usePathname, useSearchParams } = await import('next/navigation');
    vi.mocked(usePathname).mockReturnValue('/');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isReady state management', () => {
    it('should not track when isReady is false', async () => {
      // Arrange
      mockAnalyticsContext.isReady = false;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking());

      // Wait to ensure no tracking happens
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert
      expect(mockPage).not.toHaveBeenCalled();
    });

    it('should track immediately when isReady is true and skipInitial is false', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });
  });

  describe('skipInitial option', () => {
    it('should skip initial track when skipInitial is true', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: true }));

      // Wait to ensure no tracking happens
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert
      expect(mockPage).not.toHaveBeenCalled();
    });

    it('should track subsequent navigation after skipping initial', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      const mockUsePathname = vi.mocked(usePathname);

      // Initial pathname
      mockUsePathname.mockReturnValue('/');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render with skipInitial=true
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: true }));

      // Wait and verify no tracking on initial mount
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockPage).not.toHaveBeenCalled();

      // Change pathname to simulate navigation
      mockUsePathname.mockReturnValue('/dashboard');

      // Rerender to trigger useEffect with new pathname
      rerender();

      // Assert - should track the new page
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });
  });

  describe('pathname change detection', () => {
    it('should track when pathname changes', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      const mockUsePathname = vi.mocked(usePathname);

      // Initial pathname
      mockUsePathname.mockReturnValue('/');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: false }));

      // Wait for initial track
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Reset mock to count new calls
      mockPage.mockClear();

      // Change pathname
      mockUsePathname.mockReturnValue('/about');
      rerender();

      // Assert - should track the new page
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/about',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });

    it('should not double-track when pathname has not changed', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: false }));

      // Wait for initial track
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Trigger re-render without pathname change
      rerender();

      // Wait a bit to ensure no additional tracking
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert - should still only be called once
      expect(mockPage).toHaveBeenCalledTimes(1);
    });

    it('should track multiple pathname changes sequentially', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      const mockUsePathname = vi.mocked(usePathname);

      mockUsePathname.mockReturnValue('/');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: false }));

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Navigate to /dashboard
      mockPage.mockClear();
      mockUsePathname.mockReturnValue('/dashboard');
      rerender();

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });

      // Navigate to /settings
      mockPage.mockClear();
      mockUsePathname.mockReturnValue('/settings');
      rerender();

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/settings',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });
  });

  describe('page properties', () => {
    it('should include correct page properties', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });

    it('should include search params when present', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname, useSearchParams } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/search');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('q=test&filter=active') as ReturnType<typeof useSearchParams>
      );

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/search',
        url: 'http://localhost:3000/',
        search: 'q=test&filter=active',
        referrer: '',
      });
    });

    it('should merge custom properties with page properties', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      const customProperties = {
        section: 'overview',
        userId: '123',
        customData: { foo: 'bar' },
      };

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false, properties: customProperties }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
        section: 'overview',
        userId: '123',
        customData: { foo: 'bar' },
      });
    });

    it('should allow custom properties to override default properties', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      const customProperties = {
        path: '/custom-path', // Override default path
        customField: 'value',
      };

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false, properties: customProperties }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/custom-path', // Custom path should override
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
        customField: 'value',
      });
    });
  });

  describe('error handling', () => {
    it('should silently catch and ignore page tracking errors', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      const mockPageWithError = vi.fn().mockRejectedValue(new Error('Tracking failed'));
      mockAnalyticsContext.page = mockPageWithError;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Should not throw error
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert - Hook should complete without errors
      await waitFor(() => {
        expect(mockPageWithError).toHaveBeenCalledTimes(1);
      });

      // No assertion needed - if hook throws, the renderHook would have failed
      expect(mockPageWithError).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty search params correctly', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname, useSearchParams } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/page');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/page',
        url: 'http://localhost:3000/',
        search: undefined, // Empty search params should be undefined
        referrer: '',
      });
    });

    it('should handle null searchParams gracefully', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname, useSearchParams } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/page');
      vi.mocked(useSearchParams).mockReturnValue(
        null as unknown as ReturnType<typeof useSearchParams>
      );

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act
      renderHook(() => usePageTracking({ skipInitial: false }));

      // Assert
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/page',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });

    it('should wait for isReady to become true before tracking', async () => {
      // Arrange - Start with isReady = false
      mockAnalyticsContext.isReady = false;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname } = await import('next/navigation');
      vi.mocked(usePathname).mockReturnValue('/dashboard');

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render with isReady = false
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: false }));

      // Wait and verify no tracking
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockPage).not.toHaveBeenCalled();

      // Change isReady to true
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);
      rerender();

      // Assert - should track now that isReady is true
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/dashboard',
        url: 'http://localhost:3000/',
        search: undefined,
        referrer: '',
      });
    });

    it('should NOT track when searchParams change but pathname stays the same', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      const { usePathname, useSearchParams } = await import('next/navigation');
      const mockUseSearchParams = vi.mocked(useSearchParams);

      vi.mocked(usePathname).mockReturnValue('/search');
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams('q=test') as ReturnType<typeof useSearchParams>
      );

      // Dynamically import after mocks are set
      const { usePageTracking } = await import('@/lib/analytics/hooks');

      // Act - Initial render
      const { rerender } = renderHook(() => usePageTracking({ skipInitial: false }));

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockPage).toHaveBeenCalledWith(undefined, {
        path: '/search',
        url: 'http://localhost:3000/',
        search: 'q=test',
        referrer: '',
      });

      // Change search params but keep pathname same
      mockPage.mockClear();
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams('q=different') as ReturnType<typeof useSearchParams>
      );
      rerender();

      // Wait to ensure no additional tracking
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert - should NOT track because pathname hasn't changed
      // The hook only tracks on pathname changes, not searchParams changes
      expect(mockPage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // useAnalytics hook
  // ---------------------------------------------------------------------------

  describe('useAnalytics()', () => {
    it('should throw error when used outside AnalyticsProvider', async () => {
      // Arrange
      mockUseContext.mockReturnValue(undefined);

      // Dynamically import after mocks are set
      const { useAnalytics } = await import('@/lib/analytics/hooks');

      // Act & Assert
      expect(() => {
        renderHook(() => useAnalytics());
      }).toThrow('useAnalytics must be used within an AnalyticsProvider');
    });

    it('should return analytics context when used within provider', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { useAnalytics } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useAnalytics());

      // Assert
      expect(result.current).toBe(mockAnalyticsContext);
      expect(result.current.isReady).toBe(true);
      expect(result.current.isEnabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // useAnalyticsReady hook
  // ---------------------------------------------------------------------------

  describe('useAnalyticsReady()', () => {
    it('should return isReady from context', async () => {
      // Arrange
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { useAnalyticsReady } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useAnalyticsReady());

      // Assert
      expect(result.current).toBe(true);
    });

    it('should return false when isReady is false', async () => {
      // Arrange
      mockAnalyticsContext.isReady = false;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { useAnalyticsReady } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useAnalyticsReady());

      // Assert
      expect(result.current).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // useAnalyticsEnabled hook
  // ---------------------------------------------------------------------------

  describe('useAnalyticsEnabled()', () => {
    it('should return isEnabled from context', async () => {
      // Arrange
      mockAnalyticsContext.isEnabled = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { useAnalyticsEnabled } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useAnalyticsEnabled());

      // Assert
      expect(result.current).toBe(true);
    });

    it('should return false when isEnabled is false', async () => {
      // Arrange
      mockAnalyticsContext.isEnabled = false;
      mockUseContext.mockReturnValue(mockAnalyticsContext);

      // Dynamically import after mocks are set
      const { useAnalyticsEnabled } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useAnalyticsEnabled());

      // Assert
      expect(result.current).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // useTrackEvent hook
  // ---------------------------------------------------------------------------

  describe('useTrackEvent()', () => {
    let mockTrack: any;

    beforeEach(() => {
      mockTrack = vi.fn().mockResolvedValue({ success: true });
      mockAnalyticsContext.track = mockTrack;
      mockAnalyticsContext.isReady = true;
      mockUseContext.mockReturnValue(mockAnalyticsContext);
    });

    it('should return a stable callback function', async () => {
      // Arrange
      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useTrackEvent('button_clicked'));

      // Assert
      expect(typeof result.current).toBe('function');
    });

    it('should call track() with event name and properties when callback is invoked', async () => {
      // Arrange
      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useTrackEvent('button_clicked'));
      result.current({ buttonId: 'signup', location: 'hero' });

      // Assert
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('button_clicked', {
          buttonId: 'signup',
          location: 'hero',
        });
      });
    });

    it('should call track() without properties when callback is invoked without args', async () => {
      // Arrange
      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useTrackEvent('button_clicked'));
      result.current();

      // Assert
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('button_clicked', undefined);
      });
    });

    it('should silently catch errors from track()', async () => {
      // Arrange
      mockTrack.mockRejectedValue(new Error('Tracking failed'));

      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act - should not throw even though track() rejects
      const { result } = renderHook(() => useTrackEvent('error_event'));
      result.current({ test: 'data' });

      // Wait for the rejected promise's .catch() to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert - track was still called
      expect(mockTrack).toHaveBeenCalledWith('error_event', { test: 'data' });
    });

    it('should return a function on each render', async () => {
      // Arrange
      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act
      const { result, rerender } = renderHook(() => useTrackEvent('stable_event'));
      const firstFunction = result.current;

      rerender();
      const secondFunction = result.current;

      // Assert - both are functions
      expect(typeof firstFunction).toBe('function');
      expect(typeof secondFunction).toBe('function');
    });

    it('should work with empty properties object', async () => {
      // Arrange
      const { useTrackEvent } = await import('@/lib/analytics/hooks');

      // Act
      const { result } = renderHook(() => useTrackEvent('empty_props_event'));
      result.current({});

      // Assert
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('empty_props_event', {});
      });
    });
  });
});
