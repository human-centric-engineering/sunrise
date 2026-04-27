/**
 * UserIdentifier Component Tests
 *
 * Tests the UserIdentifier component which handles:
 * - Initial page load with logged-in user (identify → page)
 * - Initial page load without user (page only)
 * - Session loading states (waits for both isReady and !isPending)
 * - Preventing duplicate tracking on re-renders
 * - Resetting identification ref on logout
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/analytics/user-identifier.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { UserIdentifier } from '@/components/analytics/user-identifier';
import { logger } from '@/lib/logging';

// Hoist mock functions to avoid reference errors
const mockIdentify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTrack = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUseSession = vi.hoisted(() => vi.fn());
const mockUsePathname = vi.hoisted(() => vi.fn());
const mockUseSearchParams = vi.hoisted(() => vi.fn());
const mockUseAnalytics = vi.hoisted(() => vi.fn());

// Mock @/lib/auth/client
vi.mock('@/lib/auth/client', () => ({
  useSession: () => mockUseSession(),
}));

// Mock @/lib/analytics
vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => mockUseAnalytics(),
  EVENTS: {
    USER_LOGGED_IN: 'user_logged_in',
    USER_SIGNED_UP: 'user_signed_up',
    USER_LOGGED_OUT: 'user_logged_out',
  },
}));

// Mock @/lib/logging
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useSearchParams: () => mockUseSearchParams(),
}));

/**
 * Test Suite: UserIdentifier Component
 */
describe('components/analytics/user-identifier', () => {
  // Mock window location for URL tracking
  const originalLocation = window.location;
  const originalDocument = document.referrer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock returns
    mockUsePathname.mockReturnValue('/dashboard');
    mockUseSearchParams.mockReturnValue(new URLSearchParams('utm_source=email'));

    // Mock window.location
    delete (window as unknown as { location: unknown }).location;
    (window as unknown as { location: unknown }).location = {
      ...originalLocation,
      href: 'http://localhost:3000/dashboard?utm_source=email',
    };

    // Mock document.referrer (readonly property)
    Object.defineProperty(document, 'referrer', {
      value: 'https://google.com',
      writable: true,
      configurable: true,
    });

    // Clear sessionStorage before each test
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (window as unknown as { location: unknown }).location = originalLocation;
    Object.defineProperty(document, 'referrer', {
      value: originalDocument,
      writable: false,
      configurable: true,
    });
    // Belt-and-suspenders: clear sessionStorage in afterEach too, so a failing test
    // that sets oauth_login_pending can't pollute siblings even if beforeEach errors.
    sessionStorage.clear();
  });

  describe('Waiting for Analytics and Session', () => {
    it('should not track when analytics is not ready', async () => {
      // Arrange: Analytics not ready
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: false, // Analytics NOT ready
      });

      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act — wrap in async act so the effect has a chance to run before asserting.
      // The guard (!isReady) short-circuits early, so the assertion is meaningful
      // rather than a race-pass (effect fires but immediately returns).
      await act(async () => {
        render(<UserIdentifier />);
      });

      // Assert: Should NOT call identify or page
      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should not track when session is still loading', () => {
      // Arrange: Session still pending
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: true, // Session still loading
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Should NOT call identify or page
      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should track when both analytics is ready and session finished loading', async () => {
      // Arrange: Both ready
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true, // Analytics ready
      });

      mockUseSession.mockReturnValue({
        data: null, // Not logged in
        isPending: false, // Session finished loading
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Should call page (no user, so no identify)
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('Page Tracking Without User', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null, // No user logged in
        isPending: false,
      });
    });

    it('should track page view without calling identify', async () => {
      // Act
      render(<UserIdentifier />);

      // Assert: Only page() should be called, NOT identify()
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should track page with correct parameters', async () => {
      // Act
      render(<UserIdentifier />);

      // Assert: page() called with correct parameters
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: 'utm_source=email',
          referrer: 'https://google.com',
        });
      });
    });

    it('should handle empty search params', async () => {
      // Arrange: No search params
      mockUseSearchParams.mockReturnValue(new URLSearchParams());

      // Act
      render(<UserIdentifier />);

      // Assert: search should be undefined when empty
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: undefined,
          referrer: 'https://google.com',
        });
      });
    });

    it('should handle null search params', async () => {
      // Arrange: Search params null (edge case)
      mockUseSearchParams.mockReturnValue(null);

      // Act
      render(<UserIdentifier />);

      // Assert: search should be undefined when null
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: undefined,
          referrer: 'https://google.com',
        });
      });
    });
  });

  describe('User Identification and Page Tracking', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });
    });

    it('should call identify before page', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const callOrder: string[] = [];

      mockIdentify.mockImplementation(async () => {
        callOrder.push('identify');
      });

      mockPage.mockImplementation(async () => {
        callOrder.push('page');
      });

      // Act
      render(<UserIdentifier />);

      // Assert: identify should be called BEFORE page
      await waitFor(() => {
        expect(callOrder).toEqual(['identify', 'page']);
      });
    });

    it('should call identify with correct user ID', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-456' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: identify called with user ID
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-456');
      });
    });

    it('should track USER_LOGGED_IN for pending OAuth login and remove sessionStorage key', async () => {
      // Arrange: Seed sessionStorage with oauth_login_pending BEFORE render.
      // Source L64-70: if session.user.id exists AND sessionStorage has
      // 'oauth_login_pending', the component fires track(EVENTS.USER_LOGGED_IN)
      // with { method: 'oauth', provider } and removes the key.
      sessionStorage.setItem('oauth_login_pending', 'google');

      mockUseSession.mockReturnValue({
        data: { user: { id: 'oauth-user-1' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: track called with correct event and provider
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
          method: 'oauth',
          provider: 'google',
        });
      });

      // Assert: sessionStorage key was removed
      expect(sessionStorage.getItem('oauth_login_pending')).toBeNull();

      // Assert: identify and page still fired (OAuth login path doesn't skip them)
      expect(mockIdentify).toHaveBeenCalledWith('oauth-user-1');
      expect(mockPage).toHaveBeenCalledTimes(1);
    });

    it('should NOT track USER_LOGGED_IN when no oauth_login_pending in sessionStorage', async () => {
      // Arrange: No oauth_login_pending key — normal logged-in render
      mockUseSession.mockReturnValue({
        data: { user: { id: 'regular-user-1' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
      });

      // Assert: track was NOT called (no pending OAuth login)
      expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should track page with correct parameters after identify', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-789' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: page called with correct params
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: 'utm_source=email',
          referrer: 'https://google.com',
        });
      });
    });
  });

  describe('Preventing Duplicate Tracking', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });
    });

    it('should only track once per page load (no user)', async () => {
      // Arrange: No user
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      // Act: Render multiple times (simulating re-renders)
      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      rerender(<UserIdentifier />);
      rerender(<UserIdentifier />);

      // Assert: Should still only be called once
      expect(mockPage).toHaveBeenCalledTimes(1);
      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should only track once per page load (with user)', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act: Render multiple times
      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      rerender(<UserIdentifier />);
      rerender(<UserIdentifier />);

      // Assert: Should still only be called once
      expect(mockIdentify).toHaveBeenCalledTimes(1);
      expect(mockPage).toHaveBeenCalledTimes(1);
    });

    it('should NOT re-fire page or identify when pathname changes after initial track', async () => {
      // Arrange: User logged in, initial render with pathname '/a'
      mockUsePathname.mockReturnValue('/a');

      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      // Wait for initial track to complete
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
        expect(mockIdentify).toHaveBeenCalledTimes(1);
      });

      // Capture counts BEFORE the pathname change (no vi.clearAllMocks — see brittle pattern #4)
      const pageCallsBefore = mockPage.mock.calls.length;
      const identifyCallsBefore = mockIdentify.mock.calls.length;

      // Act: Simulate pathname change by rerendering with a new pathname
      mockUsePathname.mockReturnValue('/b');
      rerender(<UserIdentifier />);

      // Assert: hasTrackedInitialRef is true — the effect short-circuits and does NOT re-fire.
      // Counts must match the pre-change values exactly (same N before and after).
      expect(mockPage).toHaveBeenCalledTimes(pageCallsBefore);
      expect(mockIdentify).toHaveBeenCalledTimes(identifyCallsBefore);
    });

    it('should not re-identify the same user on re-render', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act: Initial render
      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
      });

      // Act: Re-render with same user
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } }, // Same user ID
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: identify should NOT be called again
      expect(mockIdentify).toHaveBeenCalledTimes(1);
    });
  });

  describe('Logout Handling', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });
    });

    it('should re-identify user after logout and new login on same instance', async () => {
      // Persistent-instance logout→re-login test. The logout effect resets both
      // identifiedUserRef and hasTrackedInitialRef, so a new session on the same instance
      // re-runs initialization and identifies the new user.

      // Arrange: User A logs in on the initial render
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      // Step 1: identify fires for user A (count = 1), page fires once
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Step 2: Logout — rerender with session = null. No additional identify or page
      // should fire, but the logout effect resets hasTrackedInitialRef so initialization
      // can re-run when a new session arrives.
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      expect(mockIdentify).toHaveBeenCalledTimes(1);

      // Step 3: User B logs in on the SAME persistent instance. Initialization re-runs
      // because the logout effect reset hasTrackedInitialRef. identify fires for user-456
      // and page fires a second time with the current URL/path.
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-456' } },
        isPending: false,
      });

      rerender(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(2);
        expect(mockIdentify).toHaveBeenLastCalledWith('user-456');
        // Guard against a broken hasTrackedInitialRef reset silently dropping
        // the second page event — the reset in the second useEffect (user-identifier.tsx:88-93)
        // must clear the ref so initialization re-runs for the new session.
        expect(mockPage).toHaveBeenCalledTimes(2);
        expect(mockPage).toHaveBeenLastCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: 'utm_source=email',
          referrer: 'https://google.com',
        });
      });
    });

    it('should re-fire page() after logout then re-login with new pathname (hasTrackedInitialRef reset isolation)', async () => {
      // This test isolates the second useEffect's hasTrackedInitialRef reset
      // (user-identifier.tsx:88-93) independently of the cross-user test above.
      //
      // Mechanism: when session?.user?.id becomes falsy, the logout effect clears
      // hasTrackedInitialRef. When the SAME user returns but on a DIFFERENT pathname,
      // the first useEffect re-fires (session?.user?.id dep is the same but the ref
      // was reset, allowing the hasTrackedInitialRef guard to pass). This verifies
      // the reset path without depending on a user-B scenario.
      //
      // Note: re-rendering with the same user AND same pathname would NOT re-fire the
      // first useEffect even after the reset, because React's dep comparison for
      // session?.user?.id, pathname, and searchParams would all be unchanged.
      // A pathname change provides the dep-array movement needed to trigger re-execution.

      // Arrange: User A logs in, initial pathname '/dashboard'
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });
      mockUsePathname.mockReturnValue('/dashboard');

      const { rerender } = render(<UserIdentifier />);

      // Step 1: initial page() fires once for user A
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Step 2: Logout — the second useEffect resets hasTrackedInitialRef
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Still only one page call after logout (logout does not trigger page)
      expect(mockPage).toHaveBeenCalledTimes(1);

      // Step 3: User A returns on a NEW pathname — ref is cleared so the
      // first useEffect re-runs initialization and fires page() a second time.
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });
      mockUsePathname.mockReturnValue('/settings');
      (window as unknown as { location: { href: string } }).location.href =
        'http://localhost:3000/settings';

      rerender(<UserIdentifier />);

      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(2);
        expect(mockPage).toHaveBeenLastCalledWith(undefined, {
          path: '/settings',
          url: 'http://localhost:3000/settings',
          search: 'utm_source=email',
          referrer: 'https://google.com',
        });
      });
    });

    it('should handle user logging out with null user object', async () => {
      // Arrange: User logged in — prime identify and page
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Capture counts BEFORE the logout rerender
      const identifyCountBefore = mockIdentify.mock.calls.length;
      const pageCountBefore = mockPage.mock.calls.length;

      // Act: Logout — session data becomes null
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: counts have NOT changed — logout does not trigger additional analytics calls
      expect(mockIdentify).toHaveBeenCalledTimes(identifyCountBefore);
      expect(mockPage).toHaveBeenCalledTimes(pageCountBefore);
    });

    it('should handle user logging out with undefined user', async () => {
      // Arrange: User logged in — prime identify and page
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      // Capture counts BEFORE the logout rerender
      const identifyCountBefore = mockIdentify.mock.calls.length;
      const pageCountBefore = mockPage.mock.calls.length;

      // Act: Logout — session.user becomes undefined
      mockUseSession.mockReturnValue({
        data: { user: undefined },
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: counts have NOT changed — undefined user does not trigger additional analytics calls
      expect(mockIdentify).toHaveBeenCalledTimes(identifyCountBefore);
      expect(mockPage).toHaveBeenCalledTimes(pageCountBefore);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });
    });

    it('should handle missing user ID gracefully', async () => {
      // Arrange: Session data exists but no user ID
      mockUseSession.mockReturnValue({
        data: { user: { id: undefined } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Should not call identify, only page
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should handle null user ID gracefully', async () => {
      // Arrange: Session data exists but user ID is null
      mockUseSession.mockReturnValue({
        data: { user: { id: null } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Should not call identify, only page
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should handle identify promise rejection gracefully', async () => {
      // Arrange: identify rejects — the rejection propagates to initialize().catch(logger.error)
      mockIdentify.mockRejectedValueOnce(new Error('identify failed'));

      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act: render should not throw (component uses .catch, not try/catch that would bubble)
      expect(() => render(<UserIdentifier />)).not.toThrow();

      // Assert: logger.error is called with the rejection — this is the real behaviour
      await waitFor(() => {
        expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
          error: expect.any(Error),
        });
      });

      // Assert: identify was attempted with correct user ID
      expect(mockIdentify).toHaveBeenCalledWith('user-123');

      // Assert: page was NOT called — identify rejected before await page() could run
      expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should handle page promise rejection gracefully', async () => {
      // Arrange: page rejects — the rejection propagates to initialize().catch(logger.error)
      mockPage.mockRejectedValueOnce(new Error('page failed'));

      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act: render should not throw
      expect(() => render(<UserIdentifier />)).not.toThrow();

      // Assert: identify WAS called (it succeeded before page rejected)
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
      });

      // Assert: logger.error is called with the page rejection
      await waitFor(() => {
        expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
          error: expect.any(Error),
        });
      });
    });

    it('should render nothing (null)', () => {
      // Arrange
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      // Act
      const { container } = render(<UserIdentifier />);

      // Assert: Should render nothing
      expect(container.firstChild).toBeNull();
    });

    it('should NOT call identify when user.id is an empty string', async () => {
      // Arrange: The source guard is `session?.user?.id && ...` — an empty string is falsy,
      // so identify should NOT be called. All other user fields are valid so only the
      // empty id triggers the guard.
      mockUseSession.mockReturnValue({
        data: { user: { id: '', email: 'user@example.com', name: 'Test User' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: page fires (always runs after the identify guard), identify does NOT
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('should NOT call page() when sessionStorage.getItem throws', async () => {
      // Arrange: sessionStorage.getItem is called inside the `if (session?.user?.id ...)` block
      // within initialize(). When it throws, the error propagates up through initialize() before
      // reaching the `await page(...)` call — so page() is NOT called. This makes the contract
      // explicit: page() is skipped whenever initialize() throws early (including storage errors).
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Use Object.defineProperty (not vi.spyOn) to override sessionStorage.getItem.
      // vi.spyOn(Storage.prototype, 'getItem') becomes ineffective after vi.clearAllMocks()
      // in happy-dom because the sessionStorage instance caches the method reference.
      const origGetItem = sessionStorage.getItem.bind(sessionStorage);
      Object.defineProperty(sessionStorage, 'getItem', {
        value: () => {
          throw new Error('sessionStorage unavailable');
        },
        configurable: true,
        writable: true,
      });

      // Act
      render(<UserIdentifier />);

      // Wait for the async to settle: logger.error is the terminal observable signal —
      // it fires after initialize().catch() handles the thrown error.
      await waitFor(() => {
        expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
          error: expect.any(Error),
        });
      });

      // Assert: page did NOT fire — the throw aborted initialize() before reaching page()
      expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

      // Restore the original getItem
      Object.defineProperty(sessionStorage, 'getItem', {
        value: origGetItem,
        configurable: true,
        writable: true,
      });
    });
  });

  describe('Browser Compatibility', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
    });

    it('should handle missing document.referrer gracefully', async () => {
      // Arrange: Mock document.referrer as empty string
      Object.defineProperty(document, 'referrer', {
        value: '',
        writable: true,
        configurable: true,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: page should be called with empty referrer
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(undefined, {
          path: '/dashboard',
          url: 'http://localhost:3000/dashboard?utm_source=email',
          search: 'utm_source=email',
          referrer: '', // Empty referrer
        });
      });
    });

    it('should use window.location.href for url field when window is defined (SSR guard line 75)', async () => {
      // Arrange: Analytics ready, no user session
      // This test verifies the affirmative branch of the SSR guard:
      // `typeof window !== 'undefined' ? window.location.href : undefined`
      // In jsdom, window is always defined so url resolves to window.location.href.
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: url is populated from window.location.href (guard branch taken)
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            url: 'http://localhost:3000/dashboard?utm_source=email',
          })
        );
      });
    });

    it('should use document.referrer for referrer field when document is defined (SSR guard line 77)', async () => {
      // Arrange: Analytics ready, no user session
      // This test verifies the affirmative branch of the SSR guard:
      // `typeof document !== 'undefined' ? document.referrer : undefined`
      // In jsdom, document is always defined so referrer resolves to document.referrer.
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      Object.defineProperty(document, 'referrer', {
        value: 'https://example.com/source',
        writable: true,
        configurable: true,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: referrer is populated from document.referrer (guard branch taken)
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            referrer: 'https://example.com/source',
          })
        );
      });
    });

    // SSR guard branches (url: undefined, referrer: undefined) cannot be exercised in jsdom:
    // vi.stubGlobal('window', undefined) prevents React from rendering at all, because
    // jsdom requires a real window object to mount components. The affirmative branches
    // (window defined → url = window.location.href, document defined → referrer = document.referrer)
    // are already covered by the two tests above this block.
    // test-review:accept untested-path — SSR guard negative branches at user-identifier.tsx:76-78 need non-jsdom env; stubbing window breaks React render
    it.todo(
      'should pass url as undefined when window is not defined (SSR guard) — requires non-jsdom SSR harness'
    );

    // test-review:accept untested-path — SSR guard negative branch at user-identifier.tsx:78 same jsdom limitation as above
    it.todo(
      'should pass referrer as undefined when document is not defined (SSR guard) — requires non-jsdom SSR harness'
    );

    // test-review:accept untested-path — authenticated-user SSR guard at user-identifier.tsx:64 same jsdom limitation; window cannot be stubbed without breaking render
    it.todo(
      'should skip OAuth sessionStorage read when window is undefined on authenticated path — requires non-jsdom SSR harness'
    );

    it('should skip OAuth sessionStorage block when user is not authenticated (mirrors SSR window guard at line 63)', async () => {
      // Arrange: No user, OAuth marker present in sessionStorage.
      // When window IS defined but there is no authenticated user, the entire
      // OAuth block (lines 63-69) is skipped because it is nested inside the
      // `if (session?.user?.id ...)` guard. This verifies that the sessionStorage
      // access at line 64 is only reached for authenticated users.
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      sessionStorage.setItem('oauth_login_pending', 'google');

      // Act
      render(<UserIdentifier />);

      // Assert: page fires but OAuth track is NOT called (block skipped)
      await waitFor(() => {
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      // Marker is left in storage (block was never entered)
      expect(sessionStorage.getItem('oauth_login_pending')).toBe('google');
    });
  });

  describe('OAuth login tracking', () => {
    beforeEach(() => {
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: true,
      });
    });

    describe('When OAuth marker exists and user is logged in', () => {
      it('should remove oauth_login_pending from sessionStorage', async () => {
        // Arrange: User logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: Wait for tracking to complete
        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'google',
          });
        });

        // Verify it's actually removed
        expect(sessionStorage.getItem('oauth_login_pending')).toBeNull();
      });

      it('should call track with correct OAuth provider (google)', async () => {
        // Arrange: User logged in with Google OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: track should be called with google provider
        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'google',
          });
        });
      });

      it('should call track with correct OAuth provider (github)', async () => {
        // Arrange: User logged in with GitHub OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-456' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'github');

        // Act
        render(<UserIdentifier />);

        // Assert: track should be called with github provider
        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'github',
          });
        });
      });

      it('should call track AFTER identify but BEFORE page', async () => {
        // Arrange: User logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        const callOrder: string[] = [];

        mockIdentify.mockImplementation(async () => {
          callOrder.push('identify');
        });

        mockTrack.mockImplementation(async () => {
          callOrder.push('track');
        });

        mockPage.mockImplementation(async () => {
          callOrder.push('page');
        });

        // Act
        render(<UserIdentifier />);

        // Assert: Call order should be identify → track → page
        await waitFor(() => {
          expect(callOrder).toEqual(['identify', 'track', 'page']);
        });
      });

      it('should only track OAuth login once per page load', async () => {
        // Arrange: User logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act: Render multiple times (simulating re-renders)
        const { rerender } = render(<UserIdentifier />);

        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledTimes(1);
        });

        rerender(<UserIdentifier />);
        rerender(<UserIdentifier />);

        // Assert: track should still only be called once
        expect(mockTrack).toHaveBeenCalledTimes(1);
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockPage).toHaveBeenCalledTimes(1);
      });
    });

    describe('When no OAuth marker exists', () => {
      it('should NOT call track when no marker present', async () => {
        // Arrange: User logged in but NO OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        // Ensure no marker in sessionStorage
        sessionStorage.removeItem('oauth_login_pending');

        // Act
        render(<UserIdentifier />);

        // Assert: track should NOT be called
        await waitFor(() => {
          expect(mockIdentify).toHaveBeenCalledTimes(1);
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should NOT call track when marker is empty string', async () => {
        // Arrange: User logged in with empty OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', '');

        // Act
        render(<UserIdentifier />);

        // Assert: track should NOT be called (empty string is falsy)
        await waitFor(() => {
          expect(mockIdentify).toHaveBeenCalledTimes(1);
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should only call identify and page in sequence', async () => {
        // Arrange: User logged in without OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.removeItem('oauth_login_pending');

        const callOrder: string[] = [];

        mockIdentify.mockImplementation(async () => {
          callOrder.push('identify');
        });

        mockPage.mockImplementation(async () => {
          callOrder.push('page');
        });

        // Act
        render(<UserIdentifier />);

        // Assert: Call order should be identify → page (no track)
        await waitFor(() => {
          expect(callOrder).toEqual(['identify', 'page']);
        });

        expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });
    });

    describe('When user is not logged in', () => {
      it('should only track page view without identify or track', async () => {
        // Arrange: No user logged in
        mockUseSession.mockReturnValue({
          data: null,
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: Only page() should be called
        await waitFor(() => {
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should leave OAuth marker in sessionStorage if not logged in', async () => {
        // Arrange: No user logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: null,
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        await waitFor(() => {
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        // Assert: OAuth marker should still be present (not removed)
        expect(sessionStorage.getItem('oauth_login_pending')).toBe('google');
      });
    });

    describe('Edge cases', () => {
      it('should handle sessionStorage errors gracefully', async () => {
        // Arrange: User logged in, mock sessionStorage.getItem to throw.
        // When getItem throws, the error propagates up through initialize() and is caught
        // by initialize().catch(logger.error). identify() runs BEFORE getItem, so it still
        // fires. page() runs AFTER the if-block and is therefore NOT called (the throw
        // unwinds before reaching the await page() call).
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        // Use Object.defineProperty (not vi.spyOn) to override sessionStorage.getItem.
        // vi.spyOn(Storage.prototype, 'getItem') becomes ineffective after vi.clearAllMocks()
        // in happy-dom because the sessionStorage instance caches the method reference.
        const origGetItem = sessionStorage.getItem.bind(sessionStorage);
        Object.defineProperty(sessionStorage, 'getItem', {
          value: () => {
            throw new Error('sessionStorage unavailable');
          },
          configurable: true,
          writable: true,
        });

        // Act
        render(<UserIdentifier />);

        // Assert: identify WAS called — it runs before the sessionStorage.getItem call
        await waitFor(() => {
          expect(mockIdentify).toHaveBeenCalledWith('user-123');
        });

        // Assert: logger.error was called with the sessionStorage error
        await waitFor(() => {
          expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
            error: expect.any(Error),
          });
        });

        // Assert: page did NOT fire — the throw aborted initialize() before reaching page()
        // (aligns with the same assertion in Edge Cases > should NOT call page() when sessionStorage.getItem throws)
        expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

        // Restore the original getItem
        Object.defineProperty(sessionStorage, 'getItem', {
          value: origGetItem,
          configurable: true,
          writable: true,
        });
      });

      it('should handle track promise rejection gracefully', async () => {
        // Arrange: track rejects — the rejection propagates to initialize().catch(logger.error)
        // OAuth marker triggers the track path: identify → track → page
        sessionStorage.setItem('oauth_login_pending', 'google');

        mockTrack.mockRejectedValueOnce(new Error('track failed'));

        mockUseAnalytics.mockReturnValue({
          identify: mockIdentify,
          page: mockPage,
          track: mockTrack,
          isReady: true,
        });

        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        // Act: render should not throw
        expect(() => render(<UserIdentifier />)).not.toThrow();

        // Assert: identify WAS called (succeeded before track rejected)
        await waitFor(() => {
          expect(mockIdentify).toHaveBeenCalledWith('user-123');
        });

        // Assert: track WAS called (it just rejected)
        expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
          method: 'oauth',
          provider: 'google',
        });

        // Assert: logger.error is called with the track rejection
        await waitFor(() => {
          expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
            error: expect.any(Error),
          });
        });

        // Assert: page was NOT called — track rejected before await page() could run
        expect(mockPage).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should handle page() rejection when no user is logged in (anonymous path)', async () => {
        // Arrange: No logged-in user; page() rejects on the anonymous path
        mockPage.mockRejectedValueOnce(new Error('page call failed'));

        mockUseAnalytics.mockReturnValue({
          identify: mockIdentify,
          page: mockPage,
          track: mockTrack,
          isReady: true,
        });

        mockUseSession.mockReturnValue({
          data: null,
          isPending: false,
        });

        // Act: render should not throw — rejection is caught by initialize().catch
        expect(() => render(<UserIdentifier />)).not.toThrow();

        // Assert: logger.error receives the page rejection (swallowed, not unhandled)
        await waitFor(() => {
          expect(vi.mocked(logger.error)).toHaveBeenCalledWith('UserIdentifier initialize failed', {
            error: expect.any(Error),
          });
        });

        // Assert: identify was never called (anonymous path skips identify)
        expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
      });

      it('should call sessionStorage.removeItem before track() on OAuth login', async () => {
        // Arrange: User logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Track call order via a shared array.
        // vi.spyOn(Storage.prototype, 'removeItem') is ineffective in happy-dom after
        // vi.clearAllMocks() because the sessionStorage instance caches the method reference.
        // Use Object.defineProperty to intercept the actual instance method instead.
        const callOrder: string[] = [];
        const origRemoveItem = sessionStorage.removeItem.bind(sessionStorage);
        Object.defineProperty(sessionStorage, 'removeItem', {
          value: (key: string) => {
            callOrder.push('removeItem');
            origRemoveItem(key);
          },
          configurable: true,
          writable: true,
        });

        mockTrack.mockImplementation(async (..._args: unknown[]) => {
          callOrder.push('track');
          return Promise.resolve();
        });

        // Act
        render(<UserIdentifier />);

        // Assert: wait for both calls to complete
        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'google',
          });
        });

        // Assert: removeItem was called before track
        const removeItemIndex = callOrder.indexOf('removeItem');
        const trackIndex = callOrder.indexOf('track');
        expect(removeItemIndex).toBeGreaterThanOrEqual(0);
        expect(trackIndex).toBeGreaterThanOrEqual(0);
        expect(removeItemIndex).toBeLessThan(trackIndex);

        // Restore original removeItem
        Object.defineProperty(sessionStorage, 'removeItem', {
          value: origRemoveItem,
          configurable: true,
          writable: true,
        });
      });

      it('should handle missing user ID when OAuth marker exists', async () => {
        // Arrange: Session data exists but no user ID, with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: undefined } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: Should not call identify or track, only page
        await waitFor(() => {
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        expect(mockIdentify).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
        expect(mockTrack).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

        // OAuth marker should remain (wasn't processed)
        expect(sessionStorage.getItem('oauth_login_pending')).toBe('google');
      });
    });
  });
});
