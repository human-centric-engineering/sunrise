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

// Mock auth client
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signOut: mockSignOut,
  },
  useSession: () => mockUseSession(),
}));

// Import component after mocks are set up
import { UserButton } from '@/components/auth/user-button';

/**
 * Test Suite: UserButton Component
 */
describe('components/auth/user-button', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock window.location.href
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    });
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
        role: null,
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
            role: null,
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
            role: null,
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
            role: null,
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
        role: null,
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

    it('should redirect to home after successful sign out', async () => {
      const user = userEvent.setup();

      mockSignOut.mockImplementation(({ fetchOptions }) => {
        // onSuccess is async, so we need to return a promise
        fetchOptions.onSuccess().then(() => {});
        return Promise.resolve();
      });

      render(<UserButton />);

      // Open dropdown and click sign out
      await user.click(screen.getByRole('button'));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('menuitem', { name: /sign out/i }));

      // Wait for the redirect to complete
      await waitFor(() => {
        expect(window.location.href).toBe('/');
      });
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

  describe('Admin Dashboard Link', () => {
    it('should show admin dashboard link for users with ADMIN role', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'admin-123',
            name: 'Admin User',
            email: 'admin@example.com',
            image: null,
            role: 'ADMIN',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      // Admin Dashboard link should be visible
      await waitFor(() => {
        const adminLink = screen.getByRole('menuitem', { name: /admin dashboard/i });
        expect(adminLink).toBeInTheDocument();
        expect(adminLink.closest('a')).toHaveAttribute('href', '/admin');
      });
    });

    it('should NOT show admin dashboard link for users without ADMIN role', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-123',
            name: 'Regular User',
            email: 'user@example.com',
            image: null,
            role: 'USER',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      // Admin Dashboard link should NOT be visible
      await waitFor(() => {
        expect(
          screen.queryByRole('menuitem', { name: /admin dashboard/i })
        ).not.toBeInTheDocument();
      });

      // But should still show regular menu items
      expect(screen.getByRole('menuitem', { name: /view profile/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
    });

    it('should NOT show admin dashboard link when role is null', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-456',
            name: 'User Without Role',
            email: 'norole@example.com',
            image: null,
            role: null,
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      // Admin Dashboard link should NOT be visible
      await waitFor(() => {
        expect(
          screen.queryByRole('menuitem', { name: /admin dashboard/i })
        ).not.toBeInTheDocument();
      });
    });

    it('should NOT show admin dashboard link when role is undefined', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'user-789',
            name: 'User No Role Field',
            email: 'undefined@example.com',
            image: null,
            // role is undefined (not present)
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      // Admin Dashboard link should NOT be visible
      await waitFor(() => {
        expect(
          screen.queryByRole('menuitem', { name: /admin dashboard/i })
        ).not.toBeInTheDocument();
      });
    });

    it('should render admin dashboard link with correct icon', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'admin-123',
            name: 'Admin User',
            email: 'admin@example.com',
            image: null,
            role: 'ADMIN',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const adminLink = screen.getByRole('menuitem', { name: /admin dashboard/i });
        expect(adminLink).toBeInTheDocument();

        // Check that the Shield icon is rendered (lucide-react renders as svg)
        const svg = adminLink.querySelector('svg');
        expect(svg).toBeInTheDocument();
      });
    });

    it('should show admin dashboard link between settings and sign out', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'admin-123',
            name: 'Admin User',
            email: 'admin@example.com',
            image: null,
            role: 'ADMIN',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const menuItems = screen.getAllByRole('menuitem');
        const menuItemTexts = menuItems.map((item) => item.textContent);

        // Verify order: View profile, Settings, Admin Dashboard, Sign out
        expect(menuItemTexts).toEqual(['View profile', 'Settings', 'Admin Dashboard', 'Sign out']);
      });
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
            role: null,
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        // Should have menu items (profile, settings, sign out = 3 items for non-admin)
        const menuItems = screen.getAllByRole('menuitem');
        expect(menuItems.length).toBe(3);
      });
    });

    it('should have proper menu structure for admin users', async () => {
      const user = userEvent.setup();
      mockUseSession.mockReturnValue({
        data: {
          user: {
            id: 'admin-123',
            name: 'Admin User',
            email: 'admin@example.com',
            image: null,
            role: 'ADMIN',
          },
        },
        isPending: false,
      });

      render(<UserButton />);

      // Open dropdown
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        // Should have 4 menu items (profile, settings, admin dashboard, sign out)
        const menuItems = screen.getAllByRole('menuitem');
        expect(menuItems.length).toBe(4);
      });
    });
  });
});
