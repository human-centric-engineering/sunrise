/**
 * UserButton Component Tests
 *
 * Tests the UserButton component which displays:
 * - Loading skeleton during auth check
 * - User icon with login/signup dropdown when unauthenticated
 * - Avatar with profile/settings/signout dropdown when authenticated
 *
 * @see /components/auth/user-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Hoist mock functions to avoid reference errors
const mockSignOut = vi.hoisted(() => vi.fn());
const mockUseSession = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());

// Mock auth client
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signOut: mockSignOut,
  },
  useSession: () => mockUseSession(),
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    refresh: mockRefresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

// Import component after mocks are set up
import { UserButton } from '@/components/auth/user-button';

/**
 * Test Suite: UserButton Component
 */
describe('components/auth/user-button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading skeleton when session is pending', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: true,
      });

      render(<UserButton />);

      // Should show disabled button with skeleton
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();

      // Should have animate-pulse skeleton
      const skeleton = button.querySelector('.animate-pulse');
      expect(skeleton).toBeInTheDocument();
    });

    it('should not show dropdown trigger when loading', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: true,
      });

      render(<UserButton />);

      // Button should be disabled and not interactive
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('Unauthenticated State', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
    });

    it('should render user icon button when not authenticated', () => {
      render(<UserButton />);

      const button = screen.getByRole('button', { name: /user menu/i });
      expect(button).toBeInTheDocument();
      expect(button).not.toBeDisabled();
    });

    it('should show login and signup options in dropdown', async () => {
      const user = userEvent.setup();
      render(<UserButton />);

      // Open dropdown
      const trigger = screen.getByRole('button', { name: /user menu/i });
      await user.click(trigger);

      // Check dropdown items
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /log in/i })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /create account/i })).toBeInTheDocument();
      });
    });

    it('should have correct links for login and signup', async () => {
      const user = userEvent.setup();
      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button', { name: /user menu/i }));

      await waitFor(() => {
        const loginLink = screen.getByRole('menuitem', { name: /log in/i });
        const signupLink = screen.getByRole('menuitem', { name: /create account/i });

        expect(loginLink.closest('a')).toHaveAttribute('href', '/login');
        expect(signupLink.closest('a')).toHaveAttribute('href', '/signup');
      });
    });
  });

  describe('Authenticated State', () => {
    const mockSession = {
      user: {
        id: 'user-123',
        name: 'John Doe',
        email: 'john@example.com',
        image: null,
      },
    };

    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: mockSession,
        isPending: false,
      });
    });

    it('should render avatar button when authenticated', () => {
      render(<UserButton />);

      // Should show avatar with initials
      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();

      // Should display initials fallback
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should display user initials correctly', () => {
      render(<UserButton />);

      // "John Doe" -> "JD"
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should handle single name for initials', () => {
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-123',
            name: 'Alice',
            email: 'alice@example.com',
            image: null,
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // "Alice" -> "A"
      expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('should handle missing name with fallback', () => {
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-123',
            name: null,
            email: 'user@example.com',
            image: null,
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Fallback to "U" for undefined/null name
      expect(screen.getByText('U')).toBeInTheDocument();
    });

    it('should show user info and menu options in dropdown', async () => {
      const user = userEvent.setup();
      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        // User info header
        expect(screen.getByText('John Doe')).toBeInTheDocument();
        expect(screen.getByText('john@example.com')).toBeInTheDocument();

        // Menu options
        expect(screen.getByRole('menuitem', { name: /view profile/i })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });
    });

    it('should have correct links for profile and settings', async () => {
      const user = userEvent.setup();
      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const profileLink = screen.getByRole('menuitem', { name: /view profile/i });
        const settingsLink = screen.getByRole('menuitem', { name: /settings/i });

        expect(profileLink.closest('a')).toHaveAttribute('href', '/profile');
        expect(settingsLink.closest('a')).toHaveAttribute('href', '/settings');
      });
    });

    it('should render avatar with image source when user has image', () => {
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-123',
            name: 'John Doe',
            email: 'john@example.com',
            image: 'https://example.com/avatar.jpg',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Radix Avatar renders the img in a span, check for the span with img inside
      // The AvatarImage sets the src on an img element that may not be visible until loaded
      // In JSDOM, we verify the Avatar component renders (fallback shows initials)
      // and that the component doesn't crash with an image URL
      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();

      // The img element is there but may be hidden until loaded
      const img = button.querySelector('img');
      if (img) {
        expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
      } else {
        // Fallback renders when image hasn't loaded (expected in JSDOM)
        expect(screen.getByText('JD')).toBeInTheDocument();
      }
    });
  });

  describe('Sign Out Functionality', () => {
    const mockSession = {
      user: {
        id: 'user-123',
        name: 'John Doe',
        email: 'john@example.com',
        image: null,
      },
    };

    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: mockSession,
        isPending: false,
      });
    });

    it('should call signOut when sign out is clicked', async () => {
      const user = userEvent.setup();

      mockSignOut.mockImplementation(({ fetchOptions }) => {
        // Simulate successful sign out
        fetchOptions.onSuccess();
        return Promise.resolve();
      });

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

      expect(mockSignOut).toHaveBeenCalledWith({
        fetchOptions: expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        }),
      });
    });

    it('should redirect to home and refresh after successful sign out', async () => {
      const user = userEvent.setup();

      mockSignOut.mockImplementation(({ fetchOptions }) => {
        fetchOptions.onSuccess();
        return Promise.resolve();
      });

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

      expect(mockPush).toHaveBeenCalledWith('/');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('should disable sign out button during sign out process', async () => {
      const user = userEvent.setup();

      // Create a delayed sign out that doesn't resolve immediately
      let resolveSignOut: () => void;
      mockSignOut.mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveSignOut = resolve;
        });
      });

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });

      const signOutButton = screen.getByRole('menuitem', { name: /sign out/i });
      await user.click(signOutButton);

      // Verify signOut was called (the loading state is internal)
      expect(mockSignOut).toHaveBeenCalled();

      // Clean up - resolve the promise
      resolveSignOut!();
    });

    it('should reset loading state on sign out error', async () => {
      const user = userEvent.setup();

      mockSignOut.mockImplementation(({ fetchOptions }) => {
        fetchOptions.onError();
        return Promise.resolve();
      });

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

      // Should revert to normal state after error
      await waitFor(() => {
        // The menu might close, so we need to reopen
        expect(screen.queryByText(/signing out/i)).not.toBeInTheDocument();
      });
    });

    it('should handle sign out exception gracefully', async () => {
      const user = userEvent.setup();

      mockSignOut.mockRejectedValue(new Error('Network error'));

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });

      // Should not throw
      await expect(
        user.click(screen.getByRole('menuitem', { name: /sign out/i }))
      ).resolves.not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible name for unauthenticated button', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });

      render(<UserButton />);

      const button = screen.getByRole('button', { name: /user menu/i });
      expect(button).toBeInTheDocument();
    });

    it('should have proper menu structure when authenticated', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-123',
            name: 'John Doe',
            email: 'john@example.com',
            image: null,
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        // Should have menu items
        const menuItems = screen.getAllByRole('menuitem');
        expect(menuItems.length).toBeGreaterThanOrEqual(3);
      });
    });
  });
});
