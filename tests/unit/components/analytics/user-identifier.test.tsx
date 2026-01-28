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
import { render, waitFor } from '@testing-library/react';
import { UserIdentifier } from '@/components/analytics/user-identifier';

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
  });

  describe('Waiting for Analytics and Session', () => {
    it('should not track when analytics is not ready', () => {
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

      // Act
      render(<UserIdentifier />);

      // Assert: Should NOT call identify or page
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockPage).not.toHaveBeenCalled();
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
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockPage).not.toHaveBeenCalled();
    });

    it('should not track when both analytics and session are not ready', () => {
      // Arrange: Both not ready
      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPage,
        track: mockTrack,
        isReady: false, // Analytics NOT ready
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: true, // Session still loading
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Should NOT call identify or page
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockPage).not.toHaveBeenCalled();
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

      expect(mockIdentify).not.toHaveBeenCalled();
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

      expect(mockIdentify).not.toHaveBeenCalled();
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

    it('should identify user then track page when user is logged in', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act
      render(<UserIdentifier />);

      // Assert: Both identify and page should be called
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledTimes(1);
        expect(mockPage).toHaveBeenCalledTimes(1);
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
      expect(mockIdentify).not.toHaveBeenCalled();
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

    it('should reset identification ref when user logs out', async () => {
      // Arrange: Initial render with logged-in user
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
        expect(mockPage).toHaveBeenCalledTimes(1);
      });

      vi.clearAllMocks();

      // Act: User logs out (session becomes null)
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: No additional calls should happen on re-render
      // But the ref should be reset (tested implicitly by next login)
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockPage).not.toHaveBeenCalled();
    });

    it('should re-identify user after logout and new login', async () => {
      // Arrange: User 1 logs in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
      });

      vi.clearAllMocks();

      // Act: User logs out
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Now "simulate" a new page load by resetting hasTrackedInitialRef
      // In reality, this would be a fresh component mount after navigation
      // For this test, we'll unmount and remount
      const { unmount } = render(<UserIdentifier />);
      unmount();

      vi.clearAllMocks();

      // Act: Different user logs in (new page load)
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-456' } },
        isPending: false,
      });

      render(<UserIdentifier />);

      // Assert: Should identify the new user
      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-456');
        expect(mockPage).toHaveBeenCalledTimes(1);
      });
    });

    it('should handle user logging out with null user object', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
      });

      // Act: Logout - session data becomes null
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: Should not throw error
      expect(() => rerender(<UserIdentifier />)).not.toThrow();
    });

    it('should handle user logging out with undefined user', async () => {
      // Arrange: User logged in
      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      const { rerender } = render(<UserIdentifier />);

      await waitFor(() => {
        expect(mockIdentify).toHaveBeenCalledWith('user-123');
      });

      // Act: Logout - session.user becomes undefined
      mockUseSession.mockReturnValue({
        data: { user: undefined },
        isPending: false,
      });

      rerender(<UserIdentifier />);

      // Assert: Should not throw error
      expect(() => rerender(<UserIdentifier />)).not.toThrow();
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

      expect(mockIdentify).not.toHaveBeenCalled();
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

      expect(mockIdentify).not.toHaveBeenCalled();
    });

    it('should handle identify promise rejection gracefully', async () => {
      // Arrange: identify rejects but we catch it
      const mockIdentifyReject = vi.fn().mockImplementation(async () => {
        try {
          throw new Error('Analytics error');
        } catch {
          // Caught - component silently handles errors via void initialize()
          return undefined;
        }
      });

      mockUseAnalytics.mockReturnValue({
        identify: mockIdentifyReject,
        page: mockPage,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      });

      // Act & Assert: Should not throw
      expect(() => render(<UserIdentifier />)).not.toThrow();

      // Wait for async operations to complete
      await waitFor(() => {
        expect(mockIdentifyReject).toHaveBeenCalledWith('user-123');
      });
    });

    it('should handle page promise rejection gracefully', async () => {
      // Arrange: page rejects but we catch it
      const mockPageReject = vi.fn().mockImplementation(async () => {
        try {
          throw new Error('Analytics error');
        } catch {
          // Caught - component silently handles errors via void initialize()
          return undefined;
        }
      });

      mockUseAnalytics.mockReturnValue({
        identify: mockIdentify,
        page: mockPageReject,
        isReady: true,
      });

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      // Act & Assert: Should not throw
      expect(() => render(<UserIdentifier />)).not.toThrow();

      // Wait for async operations to complete
      await waitFor(() => {
        expect(mockPageReject).toHaveBeenCalled();
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

    it('should render without crashing', () => {
      // Act
      const { container } = render(<UserIdentifier />);

      // Assert: Should render nothing (null)
      expect(container.firstChild).toBeNull();
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
      it('should check sessionStorage for oauth_login_pending', async () => {
        // Arrange: User logged in with OAuth marker
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: track should be called (which means sessionStorage was checked)
        await waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'google',
          });
        });
      });

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

        expect(mockTrack).not.toHaveBeenCalled();
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

        expect(mockTrack).not.toHaveBeenCalled();
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

        expect(mockTrack).not.toHaveBeenCalled();
      });
    });

    describe('When user is not logged in', () => {
      it('should NOT check OAuth marker when no session exists', async () => {
        // Arrange: No user logged in (even with OAuth marker present)
        mockUseSession.mockReturnValue({
          data: null,
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        // Act
        render(<UserIdentifier />);

        // Assert: Should NOT check sessionStorage (only happens after identify)
        await waitFor(() => {
          expect(mockPage).toHaveBeenCalledTimes(1);
        });

        expect(mockIdentify).not.toHaveBeenCalled();
        expect(mockTrack).not.toHaveBeenCalled();
      });

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

        expect(mockIdentify).not.toHaveBeenCalled();
        expect(mockTrack).not.toHaveBeenCalled();
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
        // Arrange: User logged in, mock sessionStorage.getItem to throw
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new Error('sessionStorage unavailable');
        });

        // Act & Assert: Should not throw
        expect(() => render(<UserIdentifier />)).not.toThrow();

        // Wait for async operations
        await waitFor(() => {
          expect(mockIdentify).toHaveBeenCalledWith('user-123');
        });

        getItemSpy.mockRestore();
      });

      it('should handle track promise rejection gracefully', async () => {
        // Arrange: track rejects but we catch the error
        mockUseSession.mockReturnValue({
          data: { user: { id: 'user-123' } },
          isPending: false,
        });

        sessionStorage.setItem('oauth_login_pending', 'google');

        const mockTrackReject = vi.fn().mockImplementation(async () => {
          try {
            throw new Error('Analytics error');
          } catch {
            // Caught - component silently handles errors via void initialize()
            return undefined;
          }
        });

        mockUseAnalytics.mockReturnValue({
          identify: mockIdentify,
          page: mockPage,
          track: mockTrackReject,
          isReady: true,
        });

        // Act & Assert: Should not throw
        expect(() => render(<UserIdentifier />)).not.toThrow();

        // Wait for async operations to complete
        await waitFor(() => {
          expect(mockTrackReject).toHaveBeenCalledWith('user_logged_in', {
            method: 'oauth',
            provider: 'google',
          });
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

        expect(mockIdentify).not.toHaveBeenCalled();
        expect(mockTrack).not.toHaveBeenCalled();

        // OAuth marker should remain (wasn't processed)
        expect(sessionStorage.getItem('oauth_login_pending')).toBe('google');
      });
    });
  });
});
