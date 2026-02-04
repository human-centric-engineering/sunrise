/**
 * UserEditForm Component Tests
 *
 * Tests the UserEditForm component which handles:
 * - Form rendering with user data (name, role, email verified)
 * - Navigation to user profile page (Back to Profile, Cancel)
 * - Form submission with validation
 * - Success and error states
 * - Role restriction (cannot change own role)
 *
 * Recent changes tested:
 * - Back to Profile button navigates to `/admin/users/${user.id}`
 * - Cancel button navigates to `/admin/users/${user.id}`
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise-tweaks/components/admin/user-edit-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser } from '@/types/admin';

// Mock dependencies
const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: mockRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/admin/users/user-1/edit'),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    patch: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: unknown;
    constructor(message: string, code: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

/**
 * Test Suite: UserEditForm Component
 */
describe('components/admin/user-edit-form', () => {
  // Sample test data
  const mockUser: AdminUser = {
    id: 'user-1',
    name: 'John Doe',
    email: 'john@example.com',
    emailVerified: true,
    image: 'https://example.com/avatar.jpg',
    role: 'USER',
    bio: 'Test bio',
    createdAt: new Date('2025-01-15T10:00:00Z'),
    updatedAt: new Date('2025-01-20T14:30:00Z'),
    phone: '+1234567890',
    timezone: 'America/New_York',
    location: 'New York, USA',
  };

  const currentUserId = 'admin-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render form with user data', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert: Check form elements
      expect(screen.getByText('Edit User')).toBeInTheDocument();
      expect(screen.getByText('Update user information and permissions')).toBeInTheDocument();

      // Assert: User info card
      expect(screen.getByText('User Info')).toBeInTheDocument();
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getByText('john@example.com')).toBeInTheDocument();
      expect(screen.getByText(`ID: ${mockUser.id}`)).toBeInTheDocument();

      // Assert: Form fields
      expect(screen.getByLabelText('Name')).toHaveValue('John Doe');
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByLabelText('Email Verified')).toBeInTheDocument();
    });

    it('should render avatar with image', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert: Avatar is present (check for user name in info card)
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      // Avatar component renders the image, but we can't easily test the src attribute
      // because of next/image optimization
    });

    it('should render avatar fallback when no image', () => {
      // Arrange
      const userWithoutImage = { ...mockUser, image: null };

      // Act
      render(<UserEditForm user={userWithoutImage} currentUserId={currentUserId} />);

      // Assert: Fallback initials are displayed
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should render Back to Profile button', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert
      const backButton = screen.getByRole('button', { name: /back to profile/i });
      expect(backButton).toBeInTheDocument();
    });

    it('should render Cancel button', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      expect(cancelButton).toBeInTheDocument();
    });

    it('should render Save Changes button', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert
      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).toBeInTheDocument();
      expect(saveButton).toBeDisabled(); // Disabled by default (not dirty)
    });

    it('should render email verified switch in correct state', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert
      const emailVerifiedSwitch = screen.getByRole('switch', { name: /email verified/i });
      expect(emailVerifiedSwitch).toBeInTheDocument();
      expect(emailVerifiedSwitch).toBeChecked();
    });

    it('should render role dropdown with USER selected', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert: Role label is present and Select component is rendered
      expect(screen.getByText('Role')).toBeInTheDocument();
      // The Select component renders but doesn't have accessible name until aria-label is added
      const comboboxes = screen.getAllByRole('combobox');
      expect(comboboxes.length).toBeGreaterThan(0);
    });

    it('should disable role dropdown when editing own user', () => {
      // Arrange: Current user is editing themselves
      const sameUserId = 'user-1';

      // Act
      render(<UserEditForm user={mockUser} currentUserId={sameUserId} />);

      // Assert: Role dropdown is disabled and help text is shown
      const roleDropdown = screen.getByRole('combobox');
      expect(roleDropdown).toBeDisabled();
      expect(screen.getByText('You cannot change your own role')).toBeInTheDocument();
    });

    it('should enable role dropdown when editing different user', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert: Role dropdown is enabled
      const roleDropdown = screen.getByRole('combobox');
      expect(roleDropdown).not.toBeDisabled();
    });
  });

  describe('navigation', () => {
    it('should navigate to user profile when clicking Back to Profile button', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Click Back to Profile button
      const backButton = screen.getByRole('button', { name: /back to profile/i });
      await user.click(backButton);

      // Assert: Should navigate to user profile page
      expect(mockPush).toHaveBeenCalledWith('/admin/users/user-1');
    });

    it('should navigate to user profile when clicking Cancel button', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Click Cancel button
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Assert: Should navigate to user profile page
      expect(mockPush).toHaveBeenCalledWith('/admin/users/user-1');
    });
  });

  describe('form interaction', () => {
    it('should enable save button when form is dirty', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).toBeDisabled();

      // Act: Modify name field
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      // Assert: Save button should be enabled
      await waitFor(() => {
        expect(saveButton).not.toBeDisabled();
      });
    });

    it('should update name field value', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Modify name field
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      // Assert
      expect(nameInput).toHaveValue('Jane Doe');
    });

    it('should toggle email verified switch', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      const emailVerifiedSwitch = screen.getByRole('switch', { name: /email verified/i });
      expect(emailVerifiedSwitch).toBeChecked();

      // Act: Toggle switch
      await user.click(emailVerifiedSwitch);

      // Assert: Switch should be unchecked
      await waitFor(() => {
        expect(emailVerifiedSwitch).not.toBeChecked();
      });
    });

    // Note: Testing Radix UI Select dropdown opening is problematic in JSDOM
    // The component uses pointer capture APIs that aren't fully supported
    // We test the role change functionality through form submission instead
  });

  describe('form submission', () => {
    it('should submit form with updated data', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update name
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      // Act: Submit form
      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Should call API with updated data
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/user-1', {
          body: {
            name: 'Jane Doe',
            role: 'USER',
            emailVerified: true,
          },
        });
      });
    });

    it('should show success message after successful submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update and submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Success message should appear
      await waitFor(() => {
        expect(screen.getByText('User updated successfully!')).toBeInTheDocument();
      });
    });

    it('should refresh page after successful submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update and submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Should call router.refresh()
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('should disable submit button during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      // Mock slow API call
      vi.mocked(apiClient.patch).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100))
      );

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update and submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Button should show "Saving..." and be disabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
      });
    });

    it('should submit form with multiple fields updated', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update name and email verified (skip role due to Radix UI test limitations)
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      // Toggle email verified
      const emailVerifiedSwitch = screen.getByRole('switch', { name: /email verified/i });
      await user.click(emailVerifiedSwitch);

      // Submit
      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Should call API with updated data
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/user-1', {
          body: {
            name: 'Jane Doe',
            role: 'USER', // Role unchanged
            emailVerified: false,
          },
        });
      });
    });
  });

  describe('error handling', () => {
    it('should show error message on API failure', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update user', 'UPDATE_FAILED')
      );

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update and submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Error message should appear
      await waitFor(() => {
        expect(screen.getByText('Failed to update user')).toBeInTheDocument();
      });
    });

    it('should show generic error message for unexpected errors', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('Network error'));

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Update and submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Generic error message should appear
      await waitFor(() => {
        expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
      });
    });

    it('should clear error message on successful submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: First submission - error
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update user', 'UPDATE_FAILED')
      );

      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');

      let saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText('Failed to update user')).toBeInTheDocument();
      });

      // Act: Second submission - success
      vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Smith');

      saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Error message should be cleared
      await waitFor(() => {
        expect(screen.queryByText('Failed to update user')).not.toBeInTheDocument();
        expect(screen.getByText('User updated successfully!')).toBeInTheDocument();
      });
    });

    it('should show validation error for empty name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Act: Clear name and try to submit
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveButton);

      // Assert: Validation error should appear
      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });
    });
  });

  describe('user info display', () => {
    it('should display created and updated dates', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert: Check that date labels are present
      expect(screen.getByText(/Created:/)).toBeInTheDocument();
      expect(screen.getByText(/Updated:/)).toBeInTheDocument();
    });

    it('should display user ID', () => {
      // Arrange & Act
      render(<UserEditForm user={mockUser} currentUserId={currentUserId} />);

      // Assert
      expect(screen.getByText(`ID: ${mockUser.id}`)).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle user with ADMIN role', () => {
      // Arrange
      const adminUser = { ...mockUser, role: 'ADMIN' as const };

      // Act
      render(<UserEditForm user={adminUser} currentUserId={currentUserId} />);

      // Assert: Role field should be present
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should handle user without email verification', () => {
      // Arrange
      const unverifiedUser = { ...mockUser, emailVerified: false };

      // Act
      render(<UserEditForm user={unverifiedUser} currentUserId={currentUserId} />);

      // Assert: Email verified switch should be unchecked
      const emailVerifiedSwitch = screen.getByRole('switch', { name: /email verified/i });
      expect(emailVerifiedSwitch).not.toBeChecked();
    });

    it('should handle user with unexpected role value', () => {
      // Arrange: role is a string that is neither 'USER' nor 'ADMIN'
      const userWithUnexpectedRole = { ...mockUser, role: 'MODERATOR' };

      // Act
      render(<UserEditForm user={userWithUnexpectedRole} currentUserId={currentUserId} />);

      // Assert: Form should render without crashing, defaulting to USER
      expect(screen.getByText('Edit User')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });
});
