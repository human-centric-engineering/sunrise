/**
 * FeatureFlagsPage Component Tests
 *
 * Tests the FeatureFlagsPage client component which handles:
 * - Fetching feature flags from API on mount
 * - Loading state while fetching
 * - Rendering FeatureFlagList and FeatureFlagForm after loading
 * - Managing CRUD state (creating/editing flags)
 * - Handling fetch errors gracefully
 * - Callbacks: handleFlagSaved, handleCreateClick, handleEditClick, handleFormClose
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise-tweaks/components/admin/feature-flags-page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeatureFlagsPage } from '@/components/admin/feature-flags-page';
import type { FeatureFlag } from '@/types/prisma';

// Mock child components to test parent's state management without testing children
vi.mock('@/components/admin/feature-flag-list', () => ({
  FeatureFlagList: ({
    initialFlags,
    onCreateClick,
    onEditClick,
  }: {
    initialFlags: FeatureFlag[];
    onCreateClick: () => void;
    onEditClick: (flag: FeatureFlag) => void;
  }) => (
    <div data-testid="feature-flag-list">
      <div data-testid="flags-count">{initialFlags.length}</div>
      <button data-testid="list-create-btn" onClick={onCreateClick}>
        Create Flag
      </button>
      {initialFlags.map((flag) => (
        <div key={flag.id} data-testid={`flag-${flag.id}`}>
          <span>{flag.name}</span>
          <button data-testid={`edit-${flag.id}`} onClick={() => onEditClick(flag)}>
            Edit
          </button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/admin/feature-flag-form', () => ({
  FeatureFlagForm: ({
    open,
    onOpenChange,
    onSuccess,
    flag,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (flag: FeatureFlag) => void;
    flag: FeatureFlag | null;
  }) => {
    if (!open) return null;

    return (
      <div data-testid="feature-flag-form">
        <div data-testid="form-mode">{flag ? 'edit' : 'create'}</div>
        {flag && <div data-testid="editing-flag-id">{flag.id}</div>}
        <button data-testid="form-close-btn" onClick={() => onOpenChange(false)}>
          Close
        </button>
        <button
          data-testid="form-success-btn"
          onClick={() =>
            onSuccess(
              flag || {
                id: 'new_flag_id',
                name: 'NEW_FLAG',
                enabled: true,
                description: 'Test flag',
                metadata: {},
                createdAt: new Date(),
                updatedAt: new Date(),
                createdBy: null,
              }
            )
          }
        >
          Save
        </button>
      </div>
    );
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
 * Test Suite: FeatureFlagsPage Component
 */
describe('components/admin/feature-flags-page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading state', () => {
    it('should show loading state initially', () => {
      // Arrange: Make fetch hang
      vi.mocked(global.fetch).mockImplementation(() => new Promise(() => {}));

      // Act
      render(<FeatureFlagsPage />);

      // Assert
      expect(screen.getByText('Feature Flags')).toBeInTheDocument();
      expect(
        screen.getByText('Toggle features on or off without redeployment.')
      ).toBeInTheDocument();
      expect(screen.getByText('Loading...')).toBeInTheDocument();

      // Should NOT render child components yet
      expect(screen.queryByTestId('feature-flag-list')).not.toBeInTheDocument();
      expect(screen.queryByTestId('feature-flag-form')).not.toBeInTheDocument();
    });
  });

  describe('fetching flags on mount', () => {
    it('should fetch flags from API with correct credentials', async () => {
      // Arrange
      const mockFlags = [createMockFlag()];
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: mockFlags }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Fetch should be called with correct params
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/v1/admin/feature-flags', {
          credentials: 'same-origin',
        });
      });
    });

    it('should render FeatureFlagList with fetched data', async () => {
      // Arrange
      const mockFlags = [
        createMockFlag({ id: 'flag_1', name: 'FLAG_A' }),
        createMockFlag({ id: 'flag_2', name: 'FLAG_B' }),
      ];
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: mockFlags }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Loading state should be gone
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Should render FeatureFlagList with flags
      expect(screen.getByTestId('feature-flag-list')).toBeInTheDocument();
      expect(screen.getByTestId('flags-count')).toHaveTextContent('2');
      expect(screen.getByText('FLAG_A')).toBeInTheDocument();
      expect(screen.getByText('FLAG_B')).toBeInTheDocument();
    });

    it('should render FeatureFlagForm in closed state initially', async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Form should not be visible (open=false)
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      expect(screen.queryByTestId('feature-flag-form')).not.toBeInTheDocument();
    });
  });

  describe('fetch error handling', () => {
    it('should handle non-ok response gracefully', async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Should stop loading and show empty list
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('feature-flag-list')).toBeInTheDocument();
      expect(screen.getByTestId('flags-count')).toHaveTextContent('0');
    });

    it('should handle API response with success: false', async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: { message: 'Unauthorized' } }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Should stop loading but not populate flags
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('feature-flag-list')).toBeInTheDocument();
      expect(screen.getByTestId('flags-count')).toHaveTextContent('0');
    });

    it('should handle fetch network error gracefully', async () => {
      // Arrange
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      // Act
      render(<FeatureFlagsPage />);

      // Assert: Should show empty list
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      expect(screen.getByTestId('feature-flag-list')).toBeInTheDocument();
      expect(screen.getByTestId('flags-count')).toHaveTextContent('0');
    });
  });

  describe('create flow', () => {
    it('should pass onCreateClick callback to FeatureFlagList', async () => {
      // Arrange
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Assert: Create button should exist
      expect(screen.getByTestId('list-create-btn')).toBeInTheDocument();
    });

    it('should open form in create mode when create button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Act: Click create button
      await user.click(screen.getByTestId('list-create-btn'));

      // Assert: Form should open in create mode
      expect(screen.getByTestId('feature-flag-form')).toBeInTheDocument();
      expect(screen.getByTestId('form-mode')).toHaveTextContent('create');
      expect(screen.queryByTestId('editing-flag-id')).not.toBeInTheDocument();
    });

    it('should add new flag to list after successful creation', async () => {
      // Arrange
      const user = userEvent.setup();
      const existingFlag = createMockFlag({ id: 'flag_1', name: 'EXISTING_FLAG' });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [existingFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Open create form
      await user.click(screen.getByTestId('list-create-btn'));

      // Act: Simulate successful flag creation
      await user.click(screen.getByTestId('form-success-btn'));

      // Assert: New flag should be added to the list
      await waitFor(() => {
        expect(screen.getByTestId('flags-count')).toHaveTextContent('2');
      });

      expect(screen.getByText('EXISTING_FLAG')).toBeInTheDocument();
      expect(screen.getByText('NEW_FLAG')).toBeInTheDocument();
    });
  });

  describe('edit flow', () => {
    it('should pass onEditClick callback to FeatureFlagList', async () => {
      // Arrange
      const mockFlag = createMockFlag();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [mockFlag] }),
      } as Response);

      // Act
      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Assert: Edit button should exist
      expect(screen.getByTestId(`edit-${mockFlag.id}`)).toBeInTheDocument();
    });

    it('should open form in edit mode when edit button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const mockFlag = createMockFlag({ id: 'flag_1', name: 'EDIT_ME' });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [mockFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Act: Click edit button
      await user.click(screen.getByTestId('edit-flag_1'));

      // Assert: Form should open in edit mode with correct flag
      expect(screen.getByTestId('feature-flag-form')).toBeInTheDocument();
      expect(screen.getByTestId('form-mode')).toHaveTextContent('edit');
      expect(screen.getByTestId('editing-flag-id')).toHaveTextContent('flag_1');
    });

    it('should update existing flag in list after successful edit', async () => {
      // Arrange
      const user = userEvent.setup();
      const originalFlag = createMockFlag({ id: 'flag_1', name: 'ORIGINAL_NAME', enabled: false });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [originalFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Open edit form
      await user.click(screen.getByTestId('edit-flag_1'));

      // Act: Simulate successful flag update
      // The form mock will call onSuccess with the original flag (simulating an update)
      await user.click(screen.getByTestId('form-success-btn'));

      // Assert: Flag should be updated in place, not duplicated
      await waitFor(() => {
        // Still only 1 flag
        expect(screen.getByTestId('flags-count')).toHaveTextContent('1');
      });

      // Original name should still exist (we're mocking the form's save behavior)
      expect(screen.getByText('ORIGINAL_NAME')).toBeInTheDocument();
    });

    it('should update correct flag when multiple flags exist', async () => {
      // Arrange
      const user = userEvent.setup();
      const flags = [
        createMockFlag({ id: 'flag_1', name: 'FLAG_A', enabled: false }),
        createMockFlag({ id: 'flag_2', name: 'FLAG_B', enabled: false }),
        createMockFlag({ id: 'flag_3', name: 'FLAG_C', enabled: false }),
      ];

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: flags }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Act: Edit the second flag
      await user.click(screen.getByTestId('edit-flag_2'));

      // Assert: Correct flag should be passed to form
      expect(screen.getByTestId('editing-flag-id')).toHaveTextContent('flag_2');

      // Simulate update
      await user.click(screen.getByTestId('form-success-btn'));

      // All 3 flags should still exist
      await waitFor(() => {
        expect(screen.getByTestId('flags-count')).toHaveTextContent('3');
      });
    });
  });

  describe('form close behavior', () => {
    it('should pass onOpenChange callback to FeatureFlagForm', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Open form
      await user.click(screen.getByTestId('list-create-btn'));

      // Assert: Close button should exist
      expect(screen.getByTestId('form-close-btn')).toBeInTheDocument();
    });

    it('should close form when form close callback called', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Open form
      await user.click(screen.getByTestId('list-create-btn'));
      expect(screen.getByTestId('feature-flag-form')).toBeInTheDocument();

      // Act: Close form
      await user.click(screen.getByTestId('form-close-btn'));

      // Assert: Form should be closed
      expect(screen.queryByTestId('feature-flag-form')).not.toBeInTheDocument();
    });

    it('should reset editingFlag when form closes', async () => {
      // Arrange
      const user = userEvent.setup();
      const mockFlag = createMockFlag({ id: 'flag_1', name: 'EDIT_ME' });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [mockFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Open edit form
      await user.click(screen.getByTestId('edit-flag_1'));
      expect(screen.getByTestId('editing-flag-id')).toHaveTextContent('flag_1');

      // Close form
      await user.click(screen.getByTestId('form-close-btn'));

      // Reopen create form
      await user.click(screen.getByTestId('list-create-btn'));

      // Assert: Should be in create mode now, not edit mode
      expect(screen.getByTestId('form-mode')).toHaveTextContent('create');
      expect(screen.queryByTestId('editing-flag-id')).not.toBeInTheDocument();
    });
  });

  describe('form state management', () => {
    it('should show form when showForm state is true', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Initially form should be hidden
      expect(screen.queryByTestId('feature-flag-form')).not.toBeInTheDocument();

      // Act: Open form
      await user.click(screen.getByTestId('list-create-btn'));

      // Assert: Form should be visible
      expect(screen.getByTestId('feature-flag-form')).toBeInTheDocument();
    });

    it('should set editingFlag to null when creating new flag', async () => {
      // Arrange
      const user = userEvent.setup();
      const mockFlag = createMockFlag({ id: 'flag_1' });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [mockFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // First, open edit mode
      await user.click(screen.getByTestId('edit-flag_1'));
      expect(screen.getByTestId('editing-flag-id')).toBeInTheDocument();

      // Close form
      await user.click(screen.getByTestId('form-close-btn'));

      // Act: Open create mode
      await user.click(screen.getByTestId('list-create-btn'));

      // Assert: Should be in create mode (editingFlag = null)
      expect(screen.getByTestId('form-mode')).toHaveTextContent('create');
      expect(screen.queryByTestId('editing-flag-id')).not.toBeInTheDocument();
    });

    it('should set editingFlag when editing existing flag', async () => {
      // Arrange
      const user = userEvent.setup();
      const mockFlag = createMockFlag({ id: 'flag_1', name: 'EDIT_ME' });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [mockFlag] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Act: Click edit
      await user.click(screen.getByTestId('edit-flag_1'));

      // Assert: editingFlag should be set (form shows flag ID)
      expect(screen.getByTestId('form-mode')).toHaveTextContent('edit');
      expect(screen.getByTestId('editing-flag-id')).toHaveTextContent('flag_1');
    });
  });

  describe('integration - full flow', () => {
    it('should complete create -> edit -> close flow', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);

      render(<FeatureFlagsPage />);

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });

      // Step 1: Create new flag
      await user.click(screen.getByTestId('list-create-btn'));
      expect(screen.getByTestId('form-mode')).toHaveTextContent('create');

      await user.click(screen.getByTestId('form-success-btn'));

      // New flag should be added
      await waitFor(() => {
        expect(screen.getByTestId('flags-count')).toHaveTextContent('1');
      });

      // Step 2: Edit the new flag
      await user.click(screen.getByTestId('edit-new_flag_id'));
      expect(screen.getByTestId('form-mode')).toHaveTextContent('edit');
      expect(screen.getByTestId('editing-flag-id')).toHaveTextContent('new_flag_id');

      await user.click(screen.getByTestId('form-success-btn'));

      // Should still have 1 flag (updated, not duplicated)
      await waitFor(() => {
        expect(screen.getByTestId('flags-count')).toHaveTextContent('1');
      });

      // Step 3: Close form
      await user.click(screen.getByTestId('form-close-btn'));
      expect(screen.queryByTestId('feature-flag-form')).not.toBeInTheDocument();
    });
  });
});
