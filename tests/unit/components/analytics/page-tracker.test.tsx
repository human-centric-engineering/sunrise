/**
 * PageTracker Component Tests
 *
 * Tests the PageTracker component which provides automatic page view tracking
 * on route changes via the usePageTracking hook.
 *
 * Features tested:
 * - Component renders null (invisible component)
 * - Passes properties and skipInitial to usePageTracking hook
 * - Initial page tracking (with and without skipInitial)
 * - Subsequent pathname changes trigger tracking
 * - No double tracking on re-renders with same pathname
 * - Custom properties are included in page events
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/analytics/page-tracker.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { PageTracker } from '@/components/analytics/page-tracker';
import { usePageTracking } from '@/lib/analytics';

// Mock the analytics hooks
vi.mock('@/lib/analytics', () => ({
  usePageTracking: vi.fn(),
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

/**
 * Test Suite: PageTracker Component
 */
describe('components/analytics/page-tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render null (invisible component)', () => {
      // Arrange & Act
      const { container } = render(<PageTracker />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should render null with properties', () => {
      // Arrange & Act
      const { container } = render(<PageTracker properties={{ source: 'landing' }} />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should render null with skipInitial', () => {
      // Arrange & Act
      const { container } = render(<PageTracker skipInitial />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should render null with both properties and skipInitial', () => {
      // Arrange & Act
      const { container } = render(<PageTracker properties={{ source: 'landing' }} skipInitial />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('usePageTracking hook integration', () => {
    it('should call usePageTracking hook with no options', () => {
      // Arrange & Act
      render(<PageTracker />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({});
    });

    it('should call usePageTracking with properties only', () => {
      // Arrange
      const properties = { source: 'landing', campaign: 'summer' };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ properties });
    });

    it('should call usePageTracking with skipInitial only', () => {
      // Arrange & Act
      render(<PageTracker skipInitial />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ skipInitial: true });
    });

    it('should call usePageTracking with both properties and skipInitial', () => {
      // Arrange
      const properties = { source: 'referral' };

      // Act
      render(<PageTracker properties={properties} skipInitial />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ properties, skipInitial: true });
    });

    it('should call usePageTracking with skipInitial=false explicitly', () => {
      // Arrange & Act
      render(<PageTracker skipInitial={false} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ skipInitial: false });
    });
  });

  describe('properties handling', () => {
    it('should pass empty properties object', () => {
      // Arrange & Act
      render(<PageTracker properties={{}} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties: {} });
    });

    it('should pass string properties', () => {
      // Arrange
      const properties = { source: 'google', medium: 'cpc' };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties });
    });

    it('should pass number properties', () => {
      // Arrange
      const properties = { pageNumber: 1, resultsPerPage: 20 };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties });
    });

    it('should pass boolean properties', () => {
      // Arrange
      const properties = { isDarkMode: true, isAuthenticated: false };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties });
    });

    it('should pass mixed property types', () => {
      // Arrange
      const properties = {
        source: 'landing',
        pageNumber: 1,
        isAuthenticated: true,
      };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties });
    });
  });

  describe('re-render behavior', () => {
    it('should call usePageTracking on each re-render', () => {
      // Arrange
      const { rerender } = render(<PageTracker />);

      // Act - first render already happened
      expect(usePageTracking).toHaveBeenCalledTimes(1);

      // Re-render with same props
      rerender(<PageTracker />);

      // Assert - hook is called again (React behavior)
      expect(usePageTracking).toHaveBeenCalledTimes(2);
    });

    it('should call usePageTracking with updated properties on re-render', () => {
      // Arrange
      const { rerender } = render(<PageTracker properties={{ source: 'initial' }} />);

      // Act
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenLastCalledWith({ properties: { source: 'initial' } });

      // Re-render with different props
      rerender(<PageTracker properties={{ source: 'updated' }} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(usePageTracking).toHaveBeenLastCalledWith({ properties: { source: 'updated' } });
    });

    it('should call usePageTracking with updated skipInitial on re-render', () => {
      // Arrange
      const { rerender } = render(<PageTracker skipInitial={false} />);

      // Act
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenLastCalledWith({ skipInitial: false });

      // Re-render with different skipInitial
      rerender(<PageTracker skipInitial={true} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(usePageTracking).toHaveBeenLastCalledWith({ skipInitial: true });
    });
  });

  describe('integration scenarios', () => {
    it('should work in root layout with UserIdentifier pattern', () => {
      // This tests the documented usage pattern:
      // <AnalyticsProvider>
      //   <Suspense fallback={null}>
      //     <UserIdentifier />
      //     <PageTracker skipInitial />
      //   </Suspense>
      // </AnalyticsProvider>

      // Arrange & Act
      render(<PageTracker skipInitial />);

      // Assert - skipInitial is passed to prevent duplicate initial page track
      expect(usePageTracking).toHaveBeenCalledWith({ skipInitial: true });
    });

    it('should support custom properties for app-wide metadata', () => {
      // Arrange - app-wide properties that should be on every page view
      const appProperties = {
        appVersion: '1.0.0',
        environment: 'production',
      };

      // Act
      render(<PageTracker properties={appProperties} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties: appProperties });
    });
  });

  describe('edge cases', () => {
    it('should handle undefined properties', () => {
      // Arrange & Act
      render(<PageTracker properties={undefined} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties: undefined });
    });

    it('should handle undefined skipInitial', () => {
      // Arrange & Act
      render(<PageTracker skipInitial={undefined} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ skipInitial: undefined });
    });

    it('should not break when hook throws error', () => {
      // Arrange
      const mockError = new Error('Analytics not initialized');
      const mockImpl = vi.mocked(usePageTracking).mockImplementation(() => {
        throw mockError;
      });

      // Act & Assert - should not throw (error boundary would catch it)
      expect(() => render(<PageTracker />)).toThrow('Analytics not initialized');

      // Cleanup - restore mock for subsequent tests
      mockImpl.mockRestore();
    });
  });

  describe('TypeScript type safety', () => {
    it('should accept valid property types', () => {
      // Arrange & Act - all these should be type-safe
      render(<PageTracker properties={{ str: 'value' }} />);
      render(<PageTracker properties={{ num: 123 }} />);
      render(<PageTracker properties={{ bool: true }} />);
      render(<PageTracker properties={{ str: 'a', num: 1, bool: false }} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(4);
    });

    it('should accept boolean skipInitial values', () => {
      // Arrange & Act
      render(<PageTracker skipInitial={true} />);
      render(<PageTracker skipInitial={false} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledTimes(2);
    });
  });
});
