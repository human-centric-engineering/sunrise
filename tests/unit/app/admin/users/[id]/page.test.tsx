/**
 * Admin User Profile Page Tests
 *
 * Tests the admin user profile page (read-only view) Server Component.
 *
 * Test Coverage:
 * - Page renders with complete user data
 * - Page renders with minimal user data (optional fields missing)
 * - Shows correct verification badge (Verified/Unverified)
 * - Shows bio section only when bio is present
 * - Displays "Not set" for missing optional fields
 * - Displays correct navigation links
 * - Shows user initials in avatar fallback
 * - Handles notFound when session is missing
 * - Handles notFound when user is not found
 * - Generates correct metadata
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise-tweaks/app/admin/users/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminUserProfilePage, { generateMetadata } from '@/app/admin/users/[id]/page';
import { createMockSession } from '@/tests/types/mocks';
import type { AdminUser } from '@/types/admin';

/**
 * Mock dependencies
 */
vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

// Mock ClientDate component to avoid client-side complexity
vi.mock('@/components/ui/client-date', () => ({
  ClientDate: ({ date }: { date: Date }) => <span>{date.toLocaleDateString()}</span>,
}));

import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';

/**
 * Test Suite: Admin User Profile Page
 *
 * Tests the async Server Component that displays read-only user profile.
 */
describe('AdminUserProfilePage', () => {
  /**
   * Mock fetch globally for API calls
   */
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as any;

    // Default: Authenticated session
    vi.mocked(getServerSession).mockResolvedValue(
      createMockSession({
        user: { id: 'admin-id', email: 'admin@example.com', role: 'ADMIN' },
      }) as any
    );

    // Default: Cookies setup
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [
        { name: 'session', value: 'session-token' },
        { name: 'auth', value: 'auth-token' },
      ],
    } as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Helper: Create mock user with full data
   */
  function createFullMockUser(): AdminUser {
    return {
      id: 'user-123',
      name: 'John Doe',
      email: 'john@example.com',
      emailVerified: true,
      image: 'https://example.com/avatar.jpg',
      role: 'USER',
      bio: 'This is my bio.\nMultiline text.',
      phone: '+1234567890',
      timezone: 'America/New_York',
      location: 'New York, USA',
      createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-02-20'),
    };
  }

  /**
   * Helper: Create mock user with minimal data
   */
  function createMinimalMockUser(): AdminUser {
    return {
      id: 'user-456',
      name: 'Jane Smith',
      email: 'jane@example.com',
      emailVerified: false,
      image: null,
      role: null,
      bio: null,
      phone: null,
      timezone: null,
      location: null,
      createdAt: new Date('2024-03-01'),
      updatedAt: new Date('2024-03-05'),
    };
  }

  /**
   * Helper: Mock successful API response
   */
  function mockUserApiResponse(user: AdminUser) {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...user,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        },
      }),
    } as Response);
  }

  /**
   * Helper: Mock failed API response
   */
  function mockUserApiError(status = 404) {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      json: async () => ({
        success: false,
        error: { message: 'User not found' },
      }),
    } as Response);
  }

  /**
   * Metadata Tests
   */
  describe('generateMetadata', () => {
    it('should generate correct metadata with user ID', async () => {
      // Arrange
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert
      expect(metadata.title).toBe('User user-123');
      expect(metadata.description).toBe('View user profile');
    });
  });

  /**
   * Authentication Tests
   */
  describe('authentication', () => {
    it('should call notFound when session is missing', async () => {
      // Arrange: No session
      vi.mocked(getServerSession).mockResolvedValue(null);
      const params = Promise.resolve({ id: 'user-123' });

      // Act & Assert
      await expect(AdminUserProfilePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('should fetch user data when session exists', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Verify fetch was called with correct URL and headers
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/users/user-123',
        expect.objectContaining({
          headers: {
            Cookie: 'session=session-token; auth=auth-token',
          },
          cache: 'no-store',
        })
      );
    });
  });

  /**
   * User Not Found Tests
   */
  describe('user not found', () => {
    it('should call notFound when API returns 404', async () => {
      // Arrange: API returns 404
      mockUserApiError(404);
      const params = Promise.resolve({ id: 'nonexistent' });

      // Act & Assert
      await expect(AdminUserProfilePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('should call notFound when API returns success: false', async () => {
      // Arrange: API returns success: false
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
          error: { message: 'User not found' },
        }),
      } as Response);
      const params = Promise.resolve({ id: 'user-123' });

      // Act & Assert
      await expect(AdminUserProfilePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('should call notFound when fetch throws', async () => {
      // Arrange: Fetch throws error
      mockFetch.mockRejectedValue(new Error('Network error'));
      const params = Promise.resolve({ id: 'user-123' });

      // Act & Assert
      await expect(AdminUserProfilePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });
  });

  /**
   * Rendering Tests - Full User Data
   */
  describe('rendering with full user data', () => {
    it('should render user profile with all fields', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: All data is displayed
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getAllByText('john@example.com').length).toBeGreaterThan(0);
      expect(screen.getByText('USER')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText(/This is my bio\./)).toBeInTheDocument();
      expect(screen.getByText('+1234567890')).toBeInTheDocument();
      expect(screen.getByText('America / New York')).toBeInTheDocument();
      expect(screen.getByText('New York, USA')).toBeInTheDocument();
      expect(screen.getByText('user-123')).toBeInTheDocument();
    });

    it('should render avatar component', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Avatar section is rendered (we check for initials fallback since image loading is mocked)
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should show "Verified" badge when emailVerified is true', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUser.emailVerified = true;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
    });

    it('should show bio section when bio is present', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUser.bio = 'This is my bio.\nMultiline text.';
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Bio section is rendered
      expect(screen.getByText('About')).toBeInTheDocument();
      expect(screen.getByText(/This is my bio\./)).toBeInTheDocument();
    });

    it('should format timezone with slashes replaced', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUser.timezone = 'America/New_York';
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Timezone is formatted correctly
      expect(screen.getByText('America / New York')).toBeInTheDocument();
    });

    it('should display formatted dates', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Dates are rendered via ClientDate (check for presence of date strings)
      const dateElements = screen.getAllByText(/\d{1,2}\/\d{1,2}\/\d{4}/);
      expect(dateElements.length).toBeGreaterThanOrEqual(2); // createdAt and updatedAt
    });
  });

  /**
   * Rendering Tests - Minimal User Data
   */
  describe('rendering with minimal user data', () => {
    it('should render user profile with minimal fields', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Required fields are displayed
      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      expect(screen.getAllByText('jane@example.com').length).toBeGreaterThan(0);
      expect(screen.getByText('user-456')).toBeInTheDocument();
    });

    it('should show "Unverified" badge when emailVerified is false', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.emailVerified = false;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('Unverified')).toBeInTheDocument();
      expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    });

    it('should not show bio section when bio is null', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.bio = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Bio section is not rendered
      expect(screen.queryByText('About')).not.toBeInTheDocument();
    });

    it('should show "Not set" for missing phone', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.phone = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Phone shows "Not set"
      const phoneLabels = screen.getAllByText('Phone');
      expect(phoneLabels.length).toBeGreaterThan(0);
      expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
    });

    it('should show "Not set" for missing location', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.location = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Location shows "Not set"
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
    });

    it('should show "Not set" for missing timezone', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.timezone = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Timezone shows "Not set"
      expect(screen.getByText('Timezone')).toBeInTheDocument();
      expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
    });

    it('should show default role "USER" when role is null', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.role = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Default role is shown
      expect(screen.getByText('USER')).toBeInTheDocument();
    });

    it('should show avatar fallback with initials when image is null', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.image = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Initials are displayed (JS = Jane Smith)
      expect(screen.getByText('JS')).toBeInTheDocument();
    });
  });

  /**
   * Initials Generation Tests
   */
  describe('avatar initials', () => {
    it('should generate initials from first and last name', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.name = 'John Doe';
      mockUser.image = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should handle single name', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.name = 'Madonna';
      mockUser.image = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: First letter only
      expect(screen.getByText('M')).toBeInTheDocument();
    });

    it('should limit initials to 2 characters for long names', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.name = 'John Peter Smith Johnson';
      mockUser.image = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Only first 2 initials
      expect(screen.getByText('JP')).toBeInTheDocument();
    });

    it('should capitalize initials', async () => {
      // Arrange
      const mockUser = createMinimalMockUser();
      mockUser.name = 'john doe';
      mockUser.image = null;
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-456' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: Uppercase initials
      expect(screen.getByText('JD')).toBeInTheDocument();
    });
  });

  /**
   * Navigation Tests
   */
  describe('navigation links', () => {
    it('should render "Back to Users" link', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      const backLink = screen.getByRole('link', { name: /back to users/i });
      expect(backLink).toBeInTheDocument();
      expect(backLink).toHaveAttribute('href', '/admin/users');
    });

    it('should render "Edit User" link with correct href', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      const editLink = screen.getByRole('link', { name: /edit user/i });
      expect(editLink).toBeInTheDocument();
      expect(editLink).toHaveAttribute('href', '/admin/users/user-123/edit');
    });
  });

  /**
   * Layout and Structure Tests
   */
  describe('layout structure', () => {
    it('should render Profile Details card', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('Profile Details')).toBeInTheDocument();
    });

    it('should render System Info card', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('System Info')).toBeInTheDocument();
      expect(screen.getByText('User ID')).toBeInTheDocument();
    });

    it('should display all profile detail fields', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert: All field labels are present
      expect(screen.getByText('Email')).toBeInTheDocument();
      expect(screen.getByText('Phone')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByText('Timezone')).toBeInTheDocument();
      expect(screen.getByText('Member Since')).toBeInTheDocument();
      expect(screen.getByText('Last Updated')).toBeInTheDocument();
    });
  });

  /**
   * Role Display Tests
   */
  describe('role display', () => {
    it('should display ADMIN role when user is admin', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUser.role = 'ADMIN';
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('ADMIN')).toBeInTheDocument();
    });

    it('should display USER role when user is regular user', async () => {
      // Arrange
      const mockUser = createFullMockUser();
      mockUser.role = 'USER';
      mockUserApiResponse(mockUser);
      const params = Promise.resolve({ id: 'user-123' });

      // Act
      const Component = await AdminUserProfilePage({ params });
      render(Component);

      // Assert
      expect(screen.getByText('USER')).toBeInTheDocument();
    });
  });
});
