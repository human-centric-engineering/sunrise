/**
 * ProfileForm Component Tests
 *
 * Tests the ProfileForm component which handles:
 * - User profile editing (name, bio, phone, timezone, location)
 * - Form validation with Zod schema
 * - API client integration
 * - Success/error states
 * - Router refresh on update
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/profile-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileForm } from '@/components/forms/profile-form';
import { apiClient } from '@/lib/api/client';
import type { PublicUser } from '@/types';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    patch: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(message: string, code: string, details?: Record<string, unknown>) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.details = details;
    }
  },
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/profile'),
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn(),
  })),
  EVENTS: {
    PROFILE_UPDATED: 'profile_updated',
  },
}));

/**
 * Test Suite: ProfileForm Component
 */
describe('components/forms/profile-form', () => {
  let mockRouter: { refresh: ReturnType<typeof vi.fn> };
  let mockTrack: ReturnType<typeof vi.fn>;

  const mockUser: PublicUser = {
    id: 'user123',
    name: 'John Doe',
    email: 'john@example.com',
    emailVerified: true,
    image: null,
    role: 'USER',
    bio: 'Software developer',
    phone: '+1 555-0100',
    timezone: 'America/New_York',
    location: 'New York, USA',
    preferences: {
      email: {
        marketing: false,
        productUpdates: true,
        securityAlerts: true,
      },
    },
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = {
      refresh: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue({
      ...mockRouter,
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Setup mock analytics
    const { useAnalytics } = await import('@/lib/analytics');
    mockTrack = vi.fn().mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;
    vi.mocked(useAnalytics).mockReturnValue({
      track: mockTrack,
      identify: vi.fn(),
      page: vi.fn(),
      reset: vi.fn(),
      isReady: true,
      isEnabled: true,
    } as unknown as ReturnType<typeof useAnalytics>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render all form fields with initial user data', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      expect(screen.getByLabelText('Name')).toHaveValue(mockUser.name);
      expect(screen.getByLabelText('Email')).toHaveValue(mockUser.email);
      expect(screen.getByLabelText('Bio')).toHaveValue(mockUser.bio);
      expect(screen.getByLabelText('Phone')).toHaveValue(mockUser.phone);
      expect(screen.getByLabelText('Timezone')).toBeInTheDocument();
      expect(screen.getByLabelText('Location')).toHaveValue(mockUser.location);
    });

    it('should render email field as disabled with helper text', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      const emailInput = screen.getByLabelText('Email');
      expect(emailInput).toBeDisabled();
      expect(
        screen.getByText(/email changes require verification and are not yet supported/i)
      ).toBeInTheDocument();
    });

    it('should render submit button', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      const submitButton = screen.getByRole('button', { name: /save changes/i });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });

    it('should handle null bio, phone, and location', () => {
      // Arrange
      const userWithNulls: PublicUser = {
        ...mockUser,
        bio: null,
        phone: null,
        location: null,
      };

      // Act
      render(<ProfileForm user={userWithNulls} />);

      // Assert - should render empty strings
      expect(screen.getByLabelText('Bio')).toHaveValue('');
      expect(screen.getByLabelText('Phone')).toHaveValue('');
      expect(screen.getByLabelText('Location')).toHaveValue('');
    });

    it('should not show error or success messages initially', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/successfully/i)).not.toBeInTheDocument();
    });
  });

  describe('form validation', () => {
    it('should show error for empty name', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Clear name and submit
      await user.clear(nameInput);
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/name cannot be empty/i)).toBeInTheDocument();
      });
    });

    it('should show error for name exceeding 100 characters', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Enter name with 101 characters (use fireEvent for long strings)
      fireEvent.change(nameInput, { target: { value: 'a'.repeat(101) } });
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/name must be less than 100 characters/i)).toBeInTheDocument();
      });
    });

    it('should show error for bio exceeding 500 characters', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const bioInput = screen.getByLabelText('Bio');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Enter bio with 501 characters (use fireEvent for long strings)
      fireEvent.change(bioInput, { target: { value: 'a'.repeat(501) } });
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/bio must be less than 500 characters/i)).toBeInTheDocument();
      });
    });

    it('should show error for phone exceeding 20 characters', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const phoneInput = screen.getByLabelText('Phone');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Enter phone with 21 characters (use fireEvent for efficiency)
      fireEvent.change(phoneInput, { target: { value: '1'.repeat(21) } });
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText(/phone number must be less than 20 characters/i)
        ).toBeInTheDocument();
      });
    });

    it('should show error for invalid phone number format', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const phoneInput = screen.getByLabelText('Phone');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Enter invalid phone (contains letters)
      await user.clear(phoneInput);
      await user.type(phoneInput, 'abc-123-4567');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid phone number format/i)).toBeInTheDocument();
      });
    });

    it('should show error for location exceeding 100 characters', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ProfileForm user={mockUser} />);

      const locationInput = screen.getByLabelText('Location');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Enter location with 101 characters (use fireEvent for long strings)
      fireEvent.change(locationInput, { target: { value: 'a'.repeat(101) } });
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/location must be less than 100 characters/i)).toBeInTheDocument();
      });
    });
  });

  describe('form submission', () => {
    it('should call apiClient.patch with form data', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Update name and submit
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/me', {
          body: {
            name: 'Jane Doe',
            email: mockUser.email,
            bio: mockUser.bio,
            phone: mockUser.phone,
            timezone: mockUser.timezone,
            location: mockUser.location,
          },
        });
      });
    });

    it('should convert empty strings to null for optional fields', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const bioInput = screen.getByLabelText('Bio');
      const phoneInput = screen.getByLabelText('Phone');
      const locationInput = screen.getByLabelText('Location');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Clear optional fields and submit
      await user.clear(bioInput);
      await user.clear(phoneInput);
      await user.clear(locationInput);
      await user.click(submitButton);

      // Assert - Empty strings should be converted to null
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/me', {
          body: expect.objectContaining({
            bio: null,
            phone: null,
            location: null,
          }),
        });
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument();
      });
    });

    it('should disable form fields during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const bioInput = screen.getByLabelText('Bio');
      const phoneInput = screen.getByLabelText('Phone');
      const locationInput = screen.getByLabelText('Location');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(nameInput).toBeDisabled();
        expect(bioInput).toBeDisabled();
        expect(phoneInput).toBeDisabled();
        expect(locationInput).toBeDisabled();
      });
    });

    it('should show success message on successful update', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/profile updated successfully/i)).toBeInTheDocument();
      });
    });

    it('should track PROFILE_UPDATED event with changed fields', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const bioInput = screen.getByLabelText('Bio');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Update name and bio
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.clear(bioInput);
      await user.type(bioInput, 'Updated bio');
      await user.click(submitButton);

      // Assert - Analytics track should be called with changed fields
      await waitFor(() => {
        expect(mockTrack).toHaveBeenCalledWith('profile_updated', {
          fields_changed: ['name', 'bio'],
        });
      });
    });

    it('should NOT track analytics when no fields changed', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Submit without changing anything
      await user.click(submitButton);

      // Assert - Analytics should NOT be called when no fields changed
      await waitFor(() => {
        expect(screen.getByText(/profile updated successfully/i)).toBeInTheDocument();
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('should NOT track analytics on profile update failure', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Email already in use', 'VALIDATION_ERROR')
      );

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert - Analytics should NOT be called on error
      await waitFor(() => {
        expect(screen.getByText(/email already in use/i)).toBeInTheDocument();
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('should refresh router on successful update', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockRouter.refresh).toHaveBeenCalled();
      });
    });

    it('should hide success message after 3 seconds', async () => {
      // Use fake timers for this specific test
      vi.useFakeTimers();

      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Use fireEvent for fake timer compatibility
      fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });

      await act(async () => {
        fireEvent.click(submitButton);
        // Flush promises to let the form submit
        await Promise.resolve();
      });

      // Success message should be visible
      expect(screen.getByText(/profile updated successfully/i)).toBeInTheDocument();

      // Fast-forward 3 seconds
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // Success message should be gone
      expect(screen.queryByText(/profile updated successfully/i)).not.toBeInTheDocument();

      // Restore real timers
      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('should display error message on API client error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Email already in use', 'VALIDATION_ERROR')
      );

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/email already in use/i)).toBeInTheDocument();
      });
    });

    it('should display generic error on unexpected error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('Network error'));

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act
      await user.clear(nameInput);
      await user.type(nameInput, 'Jane Doe');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unexpected error occurred/i)).toBeInTheDocument();
      });
    });

    it('should re-enable form after error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update profile', 'SERVER_ERROR')
      );

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Use fireEvent for fast value change
      fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });
      await user.click(submitButton);

      // Assert - Fields should be re-enabled after error
      await waitFor(() => {
        expect(screen.getByText(/failed to update profile/i)).toBeInTheDocument();
      });
      expect(nameInput).not.toBeDisabled();
      expect(submitButton).not.toBeDisabled();
    });

    it('should clear error when resubmitting', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.patch).mockRejectedValueOnce(
        new APIClientError('Failed to update', 'SERVER_ERROR')
      );

      render(<ProfileForm user={mockUser} />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - First submission fails (use fireEvent for fast value change)
      fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to update/i)).toBeInTheDocument();
      });

      // Second submission succeeds
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      await user.click(submitButton);

      // Assert - Error should be cleared
      await waitFor(() => {
        expect(screen.queryByText(/failed to update/i)).not.toBeInTheDocument();
        expect(screen.getByText(/profile updated successfully/i)).toBeInTheDocument();
      });
    });
  });

  describe('timezone selection', () => {
    it('should render timezone select', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert - The timezone select trigger should render
      const timezoneSelect = screen.getByLabelText('Timezone');
      expect(timezoneSelect).toBeInTheDocument();
      // The combobox role is the visible trigger for Radix Select
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should submit form with default timezone when unchanged', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      vi.mocked(apiClient.patch).mockResolvedValue({
        success: true,
        data: mockUser,
      });

      render(<ProfileForm user={mockUser} />);

      const submitButton = screen.getByRole('button', { name: /save changes/i });

      // Act - Submit without changing timezone
      await user.click(submitButton);

      // Assert - Should submit with original timezone
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith('/api/v1/users/me', {
          body: expect.objectContaining({
            timezone: 'America/New_York',
          }),
        });
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper autocomplete attributes', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      const emailInput = screen.getByLabelText('Email');
      const phoneInput = screen.getByLabelText('Phone');

      expect(emailInput).toHaveAttribute('type', 'email');
      expect(phoneInput).toHaveAttribute('type', 'tel');
    });

    it('should have associated labels for all inputs', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert - All fields should have labels
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Bio')).toBeInTheDocument();
      expect(screen.getByLabelText('Phone')).toBeInTheDocument();
      expect(screen.getByLabelText('Timezone')).toBeInTheDocument();
      expect(screen.getByLabelText('Location')).toBeInTheDocument();
    });

    it('should have helper text for bio field', () => {
      // Arrange & Act
      render(<ProfileForm user={mockUser} />);

      // Assert
      expect(
        screen.getByText(/brief description for your profile. max 500 characters/i)
      ).toBeInTheDocument();
    });
  });
});
