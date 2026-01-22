/**
 * FeatureFlagForm Component Tests
 *
 * Tests the FeatureFlagForm component which handles:
 * - Create mode (no flag prop)
 * - Edit mode (flag prop provided)
 * - Form validation
 * - SCREAMING_SNAKE_CASE name transformation
 * - API integration (POST for create, PATCH for edit)
 * - Error handling
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/admin/feature-flag-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeatureFlagForm } from '@/components/admin/feature-flag-form';
import type { FeatureFlag } from '@/types/prisma';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
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
 * Helper to create mock feature flag
 */
function createMockFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    id: 'flag_123',
    name: 'TEST_FLAG',
    enabled: false,
    description: 'Test flag description',
    metadata: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    createdBy: null,
    ...overrides,
  };
}

/**
 * Test Suite: FeatureFlagForm Component
 */
describe('components/admin/feature-flag-form', () => {
  let mockOnOpenChange: (open: boolean) => void;
  let mockOnSuccess: (flag: FeatureFlag) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockOnOpenChange = vi.fn();
    mockOnSuccess = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering - create mode', () => {
    it('should render create form when no flag prop provided', () => {
      // Arrange & Act
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert
      expect(screen.getByText('Create Feature Flag')).toBeInTheDocument();
      expect(
        screen.getByText('Create a new feature flag to control feature availability.')
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create flag/i })).toBeInTheDocument();
    });

    it('should render form fields in create mode', () => {
      // Arrange & Act
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      expect(screen.getByLabelText('Enabled by default')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('should have name field enabled in create mode', () => {
      // Arrange & Act
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert
      const nameInput = screen.getByLabelText('Name');
      expect(nameInput).not.toBeDisabled();
      expect(screen.getByText(/Use SCREAMING_SNAKE_CASE/i)).toBeInTheDocument();
    });

    it('should show enabled switch as unchecked by default', () => {
      // Arrange & Act
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert
      const enabledSwitch = screen.getByLabelText('Enabled by default');
      expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
    });
  });

  describe('rendering - edit mode', () => {
    it('should render edit form when flag prop provided', () => {
      // Arrange
      const flag = createMockFlag();

      // Act
      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={flag}
        />
      );

      // Assert
      expect(screen.getByText('Edit Feature Flag')).toBeInTheDocument();
      expect(screen.getByText('Update the feature flag settings.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('should populate form fields with existing flag data', () => {
      // Arrange
      const flag = createMockFlag({
        name: 'EXISTING_FLAG',
        description: 'Existing description',
        enabled: true,
      });

      // Act
      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={flag}
        />
      );

      // Assert
      const nameInput = screen.getByLabelText('Name');
      const descriptionInput = screen.getByLabelText('Description');
      const enabledSwitch = screen.getByLabelText('Enabled');

      expect(nameInput).toHaveValue('EXISTING_FLAG');
      expect(descriptionInput).toHaveValue('Existing description');
      expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
    });

    it('should disable name field in edit mode', () => {
      // Arrange
      const flag = createMockFlag();

      // Act
      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={flag}
        />
      );

      // Assert
      const nameInput = screen.getByLabelText('Name');
      expect(nameInput).toBeDisabled();
      expect(screen.getByText('Flag names cannot be changed')).toBeInTheDocument();
    });

    it('should show different switch label in edit mode', () => {
      // Arrange
      const flag = createMockFlag();

      // Act
      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={flag}
        />
      );

      // Assert
      expect(screen.getByLabelText('Enabled')).toBeInTheDocument();
      expect(screen.getByText('Toggle this flag on or off')).toBeInTheDocument();
    });
  });

  describe('form validation - create mode', () => {
    it('should show error for empty name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act: Submit without filling name
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });
    });

    it('should show error for invalid name format', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act: Type name that starts with lowercase (will be transformed but still invalid)
      // The component auto-transforms to uppercase, so we need to manually set an invalid value
      const nameInput = screen.getByLabelText('Name');

      // Simulate a value that bypasses the transform (e.g., starts with number or underscore)
      await user.type(nameInput, '123INVALID');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/must be in SCREAMING_SNAKE_CASE/i)).toBeInTheDocument();
      });
    });

    it('should transform name to SCREAMING_SNAKE_CASE on input', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'new feature flag');

      // Assert: Should transform to uppercase with underscores
      await waitFor(() => {
        expect(nameInput).toHaveValue('NEW_FEATURE_FLAG');
      });
    });

    it('should strip invalid characters from name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      const nameInput = screen.getByLabelText('Name');
      await user.type(nameInput, 'test-flag@123!');

      // Assert: Should only keep A-Z, 0-9, and _
      await waitFor(() => {
        expect(nameInput).toHaveValue('TEST_FLAG_123_');
      });
    });

    it('should show error for description too long', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      const nameInput = screen.getByLabelText('Name');
      const descriptionInput = screen.getByLabelText('Description');

      await user.type(nameInput, 'TEST_FLAG');
      await user.type(descriptionInput, 'a'.repeat(501));
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText('Description must be less than 500 characters')
        ).toBeInTheDocument();
      });
    });
  });

  describe('form submission - create mode', () => {
    it('should call POST endpoint when creating new flag', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const createdFlag = createMockFlag({ name: 'NEW_FLAG', enabled: true });

      vi.mocked(apiClient.post).mockResolvedValue(createdFlag);

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'NEW_FLAG');
      await user.type(screen.getByLabelText('Description'), 'A new test flag');
      await user.click(screen.getByLabelText('Enabled by default'));
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith('/api/v1/admin/feature-flags', {
          body: {
            name: 'NEW_FLAG',
            description: 'A new test flag',
            enabled: true,
          },
        });
      });
    });

    it('should call onSuccess with created flag data', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const createdFlag = createMockFlag({ name: 'NEW_FLAG' });

      vi.mocked(apiClient.post).mockResolvedValue(createdFlag);

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'NEW_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledWith(createdFlag);
      });
    });

    it('should close dialog after successful creation', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const createdFlag = createMockFlag();

      vi.mocked(apiClient.post).mockResolvedValue(createdFlag);

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'TEST_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');

      // Make the API call hang
      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'TEST_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled();
      });
    });

    it('should display error message on creation failure', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Flag already exists', 'CONFLICT')
      );

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'DUPLICATE_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Flag already exists')).toBeInTheDocument();
      });
    });
  });

  describe('form submission - edit mode', () => {
    it('should call PATCH endpoint when editing existing flag', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const existingFlag = createMockFlag({ enabled: false });
      const updatedFlag = createMockFlag({ enabled: true });

      vi.mocked(apiClient.patch).mockResolvedValue(updatedFlag);

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={existingFlag}
        />
      );

      // Act: Toggle enabled and submit
      await user.click(screen.getByLabelText('Enabled'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          `/api/v1/admin/feature-flags/${existingFlag.id}`,
          {
            body: {
              description: existingFlag.description,
              enabled: true,
            },
          }
        );
      });
    });

    it('should not include name in PATCH request', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const existingFlag = createMockFlag({ name: 'EXISTING_FLAG' });
      const updatedFlag = createMockFlag();

      vi.mocked(apiClient.patch).mockResolvedValue(updatedFlag);

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={existingFlag}
        />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert: Name should not be in the request body
      await waitFor(() => {
        const callArgs = vi.mocked(apiClient.patch).mock.calls[0];
        expect(callArgs?.[1]?.body).not.toHaveProperty('name');
      });
    });

    it('should call onSuccess with updated flag data in edit mode', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const existingFlag = createMockFlag();
      const updatedFlag = createMockFlag({ description: 'Updated description' });

      vi.mocked(apiClient.patch).mockResolvedValue(updatedFlag);

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={existingFlag}
        />
      );

      // Act
      await user.clear(screen.getByLabelText('Description'));
      await user.type(screen.getByLabelText('Description'), 'Updated description');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledWith(updatedFlag);
      });
    });

    it('should show loading state during edit submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const existingFlag = createMockFlag();

      // Make the API call hang
      vi.mocked(apiClient.patch).mockImplementation(() => new Promise(() => {}));

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={existingFlag}
        />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
      });
    });

    it('should display error message on update failure', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      const existingFlag = createMockFlag();

      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Failed to update flag', 'SERVER_ERROR')
      );

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={existingFlag}
        />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Failed to update flag')).toBeInTheDocument();
      });
    });
  });

  describe('form reset and dialog behavior', () => {
    it('should reset form when dialog closes', async () => {
      // Arrange
      const user = userEvent.setup();
      const { rerender } = render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act: Fill form
      await user.type(screen.getByLabelText('Name'), 'TEST_FLAG');
      await user.type(screen.getByLabelText('Description'), 'Test description');

      // Act: Close dialog
      rerender(
        <FeatureFlagForm open={false} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act: Reopen dialog
      rerender(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert: Form should be reset
      const nameInput = screen.getByLabelText('Name');
      const descriptionInput = screen.getByLabelText('Description');

      expect(nameInput).toHaveValue('');
      expect(descriptionInput).toHaveValue('');
    });

    it('should clear error when dialog closes', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      const { rerender } = render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Test error', 'ERROR'));

      // Act: Trigger error
      await user.type(screen.getByLabelText('Name'), 'TEST_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      await waitFor(() => {
        expect(screen.getByText('Test error')).toBeInTheDocument();
      });

      // Act: Close dialog
      rerender(
        <FeatureFlagForm open={false} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act: Reopen dialog
      rerender(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Assert: Error should be cleared
      expect(screen.queryByText('Test error')).not.toBeInTheDocument();
    });

    it('should call onOpenChange when cancel button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      // Assert
      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('enabled switch behavior', () => {
    it('should toggle enabled switch in create mode', async () => {
      // Arrange
      const user = userEvent.setup();
      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      const enabledSwitch = screen.getByLabelText('Enabled by default');

      // Act
      await user.click(enabledSwitch);

      // Assert
      expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');

      // Act: Toggle again
      await user.click(enabledSwitch);

      // Assert
      expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
    });

    it('should toggle enabled switch in edit mode', async () => {
      // Arrange
      const user = userEvent.setup();
      const flag = createMockFlag({ enabled: false });

      render(
        <FeatureFlagForm
          open={true}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          flag={flag}
        />
      );

      const enabledSwitch = screen.getByLabelText('Enabled');

      // Act
      await user.click(enabledSwitch);

      // Assert
      expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('unexpected errors', () => {
    it('should handle unexpected errors gracefully', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      render(
        <FeatureFlagForm open={true} onOpenChange={mockOnOpenChange} onSuccess={mockOnSuccess} />
      );

      // Act
      await user.type(screen.getByLabelText('Name'), 'TEST_FLAG');
      await user.click(screen.getByRole('button', { name: /create flag/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
      });
    });
  });
});
