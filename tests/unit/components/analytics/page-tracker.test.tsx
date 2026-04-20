/**
 * PageTracker Component Tests
 *
 * Tests the PageTracker component which provides automatic page view tracking
 * on route changes via the usePageTracking hook.
 *
 * Features tested:
 * - Component renders null (invisible component)
 * - Passes properties and skipInitial to usePageTracking hook
 * - Hook is called exactly once per mount (merged into no-options test)
 * - Re-renders propagate updated props to the hook
 * - Hook return value is discarded (wrapper is intentional no-op)
 * - No post-unmount hook calls
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/analytics/page-tracker.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Suspense, Component, type ErrorInfo, type ReactNode } from 'react';
import { PageTracker } from '@/components/analytics/page-tracker';
import { usePageTracking } from '@/lib/analytics';

/**
 * Minimal class-based error boundary for testing purposes.
 * Catches errors from children and renders a fallback element.
 */
class TestErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally suppressed — boundary absorbs the error in tests
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Mock the analytics hooks (overrides global setup.ts mock for this file)
vi.mock('@/lib/analytics', () => ({
  usePageTracking: vi.fn(),
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
  });

  describe('usePageTracking hook integration', () => {
    it('should call usePageTracking hook with no options', () => {
      // Arrange & Act
      render(<PageTracker />);

      // Assert — component destructures { properties, skipInitial } from props;
      // when no props are passed both values are undefined, not an empty object.
      // The count assertion also proves the hook is not silently skipped or called
      // multiple times — single-fire on mount is the contract.
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({
        properties: undefined,
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking with properties only', () => {
      // Arrange
      const properties = { source: 'landing', campaign: 'summer' };

      // Act
      render(<PageTracker properties={properties} />);

      // Assert — source always passes both keys so skipInitial: undefined will be present
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({
        properties: { source: 'landing', campaign: 'summer' },
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking with skipInitial only', () => {
      // Arrange & Act
      render(<PageTracker skipInitial />);

      // Assert — source always passes both keys so properties: undefined will be present
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ properties: undefined, skipInitial: true });
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

      // Assert — both keys must be present to be consistent with sibling tests at L61/L82/L94
      // which always assert the full call shape including properties: undefined
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(usePageTracking).toHaveBeenCalledWith({ properties: undefined, skipInitial: false });
    });
  });

  describe('properties handling', () => {
    it('should pass empty properties object', () => {
      // Arrange & Act
      render(<PageTracker properties={{}} />);

      // Assert
      expect(usePageTracking).toHaveBeenCalledWith({ properties: {} });
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
    it('should call usePageTracking on first render with initial props', () => {
      // Arrange
      const initialProps = { source: 'home' };
      render(<PageTracker properties={initialProps} />);

      // Assert — hook receives initial props on first render
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(vi.mocked(usePageTracking).mock.calls[0][0]).toEqual({
        properties: initialProps,
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking on re-render with updated props', () => {
      // Arrange
      const initialProps = { source: 'home' };
      const updatedProps = { source: 'search' };
      const { rerender } = render(<PageTracker properties={initialProps} />);

      // Act — re-render with different props
      rerender(<PageTracker properties={updatedProps} />);

      // Assert — hook receives updated props on second render
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(vi.mocked(usePageTracking).mock.calls[1][0]).toEqual({
        properties: updatedProps,
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking with initial properties on first render', () => {
      // Arrange & Act
      render(<PageTracker properties={{ source: 'initial' }} />);

      // Assert — first render receives the initial properties
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(vi.mocked(usePageTracking).mock.calls[0][0]).toEqual({
        properties: { source: 'initial' },
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking with updated properties after re-render', () => {
      // Arrange
      const { rerender } = render(<PageTracker properties={{ source: 'initial' }} />);

      // Act — re-render with different properties
      rerender(<PageTracker properties={{ source: 'updated' }} />);

      // Assert — second render receives the updated properties
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(vi.mocked(usePageTracking).mock.calls[1][0]).toEqual({
        properties: { source: 'updated' },
        skipInitial: undefined,
      });
    });

    it('should call usePageTracking with initial skipInitial on first render', () => {
      // Arrange & Act
      render(<PageTracker skipInitial={false} />);

      // Assert — first render receives the initial skipInitial value
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(vi.mocked(usePageTracking).mock.calls[0][0]).toEqual({
        properties: undefined,
        skipInitial: false,
      });
    });

    it('should call usePageTracking with updated skipInitial after re-render', () => {
      // Arrange
      const { rerender } = render(<PageTracker skipInitial={false} />);

      // Act — re-render with different skipInitial
      rerender(<PageTracker skipInitial={true} />);

      // Assert — second render receives the updated skipInitial value
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(vi.mocked(usePageTracking).mock.calls[1][0]).toEqual({
        properties: undefined,
        skipInitial: true,
      });
    });

    it('should forward skipInitial transitioning from true to false on re-render', () => {
      // Arrange — start with skipInitial=true
      const { rerender } = render(<PageTracker skipInitial={true} />);

      // Assert — first render
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(vi.mocked(usePageTracking).mock.calls[0][0]).toEqual({
        properties: undefined,
        skipInitial: true,
      });

      // Act — transition to skipInitial=false
      rerender(<PageTracker skipInitial={false} />);

      // Assert — second render receives false; both keys present to match full call shape
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(vi.mocked(usePageTracking).mock.calls[1][0]).toEqual({
        properties: undefined,
        skipInitial: false,
      });
    });

    it('should forward new properties object reference when only identity changes on re-render', () => {
      // Arrange — render with initial object
      const propsV1 = { source: 'a' };
      const { rerender } = render(<PageTracker properties={propsV1} />);

      // Assert — first render used propsV1
      expect(usePageTracking).toHaveBeenCalledTimes(1);
      expect(vi.mocked(usePageTracking).mock.calls[0][0]).toEqual({
        properties: propsV1,
        skipInitial: undefined,
      });

      // Act — rerender with a new object reference but same value
      const propsV2 = { source: 'a' };
      rerender(<PageTracker properties={propsV2} />);

      // Assert — hook was called again with the new reference
      expect(usePageTracking).toHaveBeenCalledTimes(2);
      expect(vi.mocked(usePageTracking).mock.calls[1][0]).toEqual({
        properties: propsV2,
        skipInitial: undefined,
      });
    });
  });

  describe('integration scenarios', () => {
    it('should render invisibly when wrapped in a Suspense boundary (imitates root layout usage)', () => {
      // React propagates errors and renders from children inside Suspense boundaries.
      // Wrapping PageTracker in Suspense (as in the actual root layout) must not
      // affect the component's null output.

      // Arrange & Act
      const { container } = render(
        <Suspense fallback={null}>
          <PageTracker skipInitial />
        </Suspense>
      );

      // Assert — the component is invisible (null) even inside Suspense
      expect(container.firstChild).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('should not call usePageTracking again after unmount', () => {
      // Arrange — render and confirm exactly one hook call on mount
      const { unmount } = render(<PageTracker />);
      expect(usePageTracking).toHaveBeenCalledTimes(1);

      // Act — unmount the component
      unmount();

      // Assert — call count must not have increased; proves no post-unmount re-fire
      // (guards against leaked route-change subscribers if the hook ever adds them).
      // Explicit count comparison avoids mid-test vi.clearAllMocks() (brittle pattern #4).
      expect(usePageTracking).toHaveBeenCalledTimes(1);
    });

    it("should discard the hook's return value", () => {
      // Arrange — give the mock a non-void return value to confirm the wrapper ignores it
      vi.mocked(usePageTracking).mockReturnValue({ anything: 'value' } as unknown as ReturnType<
        typeof usePageTracking
      >);

      // Act
      const { container } = render(<PageTracker />);

      // Assert — the wrapper returns null regardless of what the hook returns;
      // documents the intentional no-op behaviour of the wrapper component.
      expect(container.firstChild).toBeNull();
    });
  });

  describe('edge cases', () => {
    // React propagates errors from children by design — an error in usePageTracking
    // will propagate up to the nearest error boundary rather than being swallowed.
    it('should propagate hook errors to the nearest error boundary', () => {
      // Arrange
      const mockError = new Error('Analytics not initialized');
      const mockImpl = vi.mocked(usePageTracking).mockImplementation(() => {
        throw mockError;
      });

      // Act & Assert — error propagates up as expected (React does not suppress it)
      expect(() => render(<PageTracker />)).toThrow('Analytics not initialized');

      // Cleanup - restore mock for subsequent tests
      mockImpl.mockRestore();
    });

    it('should be caught by a React error boundary when usePageTracking throws', () => {
      // Validates the production <Suspense> + error boundary path described in the JSDoc.
      // A bare throw from usePageTracking propagates up the React tree; a real error
      // boundary intercepts it and renders the fallback — confirming PageTracker does
      // not suppress errors and that the boundary contract works end-to-end.

      // Arrange — silence the expected React error output from the boundary
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(usePageTracking).mockImplementation(() => {
        throw new Error('Analytics not initialized');
      });

      // Act
      render(
        <TestErrorBoundary fallback={<div>Analytics unavailable</div>}>
          <Suspense fallback={null}>
            <PageTracker />
          </Suspense>
        </TestErrorBoundary>
      );

      // Assert — boundary caught the error and rendered the fallback UI
      expect(screen.getByText('Analytics unavailable')).toBeInTheDocument();

      // Cleanup
      consoleError.mockRestore();
    });
  });
});
