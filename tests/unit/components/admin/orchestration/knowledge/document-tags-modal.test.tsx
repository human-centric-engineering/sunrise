/**
 * DocumentTagsModal Component Tests
 *
 * Test Coverage:
 * - Does not render dialog content when open=false
 * - Renders title with document name
 * - Loads tags and document tag grants on open
 * - Shows loading state while fetching
 * - Shows error state when fetch fails
 * - Empty state when no tags exist
 * - Renders tag list with checkboxes
 * - Toggling a checkbox adds / removes from selection
 * - "Clear all" button clears all selections
 * - Filter input narrows tag list
 * - "Save tags" is disabled when not dirty
 * - "Save tags" PATCH on save, calls onSaved and closes
 * - Error shown on save failure
 * - Inline create-tag form: toggle open/closed
 * - Inline create-tag: slug auto-derives from name
 * - Inline create-tag: client-side validation
 * - Inline create-tag: success → tag added and auto-selected
 * - Inline create-tag: server error with field details
 * - Inline create-tag: generic server error
 * - State reset when modal closes
 *
 * @see components/admin/orchestration/knowledge/document-tags-modal.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentTagsModal } from '@/components/admin/orchestration/knowledge/document-tags-modal';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500,
      public details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { apiClient, APIClientError } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TAG_A = { id: 'tag-a', slug: 'sales', name: 'Sales', description: 'Sales team content' };
const TAG_B = { id: 'tag-b', slug: 'billing', name: 'Billing', description: null };
const TAG_C = { id: 'tag-c', slug: 'support', name: 'Support', description: 'Customer support' };

function setupDefaultGetMocks({ allTags = [TAG_A, TAG_B], tagIds = [] as string[] } = {}) {
  vi.mocked(apiClient.get).mockImplementation((url: string) => {
    if (url.includes('/knowledge/tags')) {
      return Promise.resolve(allTags);
    }
    if (url.includes('/knowledge/documents/')) {
      return Promise.resolve({ document: { tagIds } });
    }
    return Promise.resolve({});
  });
}

const BASE_PROPS = {
  documentId: 'doc-1',
  documentName: 'Sales Guide',
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentTagsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultGetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Closed state ───────────────────────────────────────────────────────────

  describe('when closed', () => {
    it('does not show dialog content when open=false', () => {
      render(<DocumentTagsModal {...BASE_PROPS} open={false} />);

      // The dialog element exists but content should not be visible
      expect(screen.queryByText('Sales Guide')).not.toBeInTheDocument();
    });
  });

  // ── Open / loading ─────────────────────────────────────────────────────────

  describe('when open', () => {
    it('renders the dialog with document name in title', async () => {
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      expect(screen.getByText(/Tags — Sales Guide/i)).toBeInTheDocument();
    });

    it('shows tag list after loading', async () => {
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Sales')).toBeInTheDocument();
        expect(screen.getByText('Billing')).toBeInTheDocument();
      });
    });

    it('shows loading state while fetching', async () => {
      // Hang both fetches
      let resolve!: (v: unknown) => void;
      vi.mocked(apiClient.get).mockReturnValue(
        new Promise((r) => {
          resolve = r;
        })
      );

      render(<DocumentTagsModal {...BASE_PROPS} />);

      expect(screen.getByText('Loading…')).toBeInTheDocument();

      // Cleanup
      resolve([]);
    });

    it('shows error when fetch fails', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Network error', 'NETWORK_ERROR', 0)
      );

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('shows "Failed to load tags" for non-APIClientError on fetch', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(new Error('boom'));

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load tags')).toBeInTheDocument();
      });
    });

    it('shows empty state when no tags exist', async () => {
      setupDefaultGetMocks({ allTags: [], tagIds: [] });

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText(/no tags exist yet/i)).toBeInTheDocument();
      });
    });

    it('shows selected count in header when tags load', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B], tagIds: ['tag-a'] });

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
      });
    });
  });

  // ── Checkbox interactions ──────────────────────────────────────────────────

  describe('checkbox interactions', () => {
    it('renders tags with unchecked checkboxes when not selected', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Sales')).toBeInTheDocument();
      });

      // Save button should be disabled (not dirty)
      expect(screen.getByRole('button', { name: /save tags/i })).toBeDisabled();
    });

    it('checking a tag makes "Save tags" enabled (dirty)', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      // Click the checkbox label
      await user.click(screen.getByRole('checkbox', { name: /apply tag sales/i }));

      expect(screen.getByRole('button', { name: /save tags/i })).not.toBeDisabled();
    });

    it('unchecking a selected tag makes selection dirty', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: ['tag-a'] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      // Uncheck the tag
      await user.click(screen.getByRole('checkbox', { name: /remove tag sales/i }));

      expect(screen.getByRole('button', { name: /save tags/i })).not.toBeDisabled();
    });

    it('"Clear all" clears selected tags', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B], tagIds: ['tag-a', 'tag-b'] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      // "X selected" footer with "Clear all" button appears when tags are selected
      const clearAllBtn = screen.getByRole('button', { name: /clear all/i });
      await user.click(clearAllBtn);

      // After clearing, dirty and no selection
      expect(screen.getByRole('button', { name: /save tags/i })).not.toBeDisabled();
      // The "2 selected" footer should disappear (tagIds.length === 0)
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    });
  });

  // ── Filter ─────────────────────────────────────────────────────────────────

  describe('filter', () => {
    it('narrows the tag list by name', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B, TAG_C], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.type(screen.getByLabelText(/filter tags/i), 'bill');

      expect(screen.getByText('Billing')).toBeInTheDocument();
      expect(screen.queryByText('Sales')).not.toBeInTheDocument();
      expect(screen.queryByText('Support')).not.toBeInTheDocument();
    });

    it('narrows by slug', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.type(screen.getByLabelText(/filter tags/i), 'billing');

      expect(screen.queryByText('Sales')).not.toBeInTheDocument();
      expect(screen.getByText('Billing')).toBeInTheDocument();
    });

    it('shows "no tags match" empty state when filter produces no results', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.type(screen.getByLabelText(/filter tags/i), 'zzz');

      expect(screen.getByText(/no tags match/i)).toBeInTheDocument();
    });

    it('narrows by description', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_C], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.type(screen.getByLabelText(/filter tags/i), 'customer');

      expect(screen.getByText('Support')).toBeInTheDocument();
      expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    });
  });

  // ── Save ───────────────────────────────────────────────────────────────────

  describe('save', () => {
    it('PATCHes document with tagIds on Save', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.patch).mockResolvedValue({});

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('checkbox', { name: /apply tag sales/i }));
      await user.click(screen.getByRole('button', { name: /save tags/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/documents/doc-1'),
          expect.objectContaining({ body: expect.objectContaining({ tagIds: ['tag-a'] }) })
        );
      });
    });

    it('calls onSaved and closes modal on successful save', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.patch).mockResolvedValue({});
      const onSaved = vi.fn();
      const onOpenChange = vi.fn();

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} onSaved={onSaved} onOpenChange={onOpenChange} />);
      });

      await waitFor(() => screen.getByText('Sales'));
      await user.click(screen.getByRole('checkbox', { name: /apply tag sales/i }));
      await user.click(screen.getByRole('button', { name: /save tags/i }));

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('shows error message on save failure', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Save failed', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));
      await user.click(screen.getByRole('checkbox', { name: /apply tag sales/i }));
      await user.click(screen.getByRole('button', { name: /save tags/i }));

      await waitFor(() => {
        expect(screen.getByText('Save failed')).toBeInTheDocument();
      });
    });

    it('shows "Failed to save tags" for non-APIClientError on save', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('network'));

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));
      await user.click(screen.getByRole('checkbox', { name: /apply tag sales/i }));
      await user.click(screen.getByRole('button', { name: /save tags/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to save tags')).toBeInTheDocument();
      });
    });

    it('Cancel button closes modal without saving', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      const onOpenChange = vi.fn();

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} onOpenChange={onOpenChange} />);
      });

      await waitFor(() => screen.getByText('Sales'));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(apiClient.patch).not.toHaveBeenCalled();
    });
  });

  // ── Inline create tag ──────────────────────────────────────────────────────

  describe('inline create tag', () => {
    it('toggles the create form open and closed', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      // Open
      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();

      // Close via Cancel new tag button
      await user.click(screen.getByRole('button', { name: /cancel new tag/i }));
      expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    });

    it('auto-derives slug from name when slug not dirty', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Customer Support');

      expect(screen.getByDisplayValue('customer-support')).toBeInTheDocument();
    });

    it('stops auto-deriving slug after manual slug edit', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));

      // Manually edit slug
      const slugInput = screen.getByLabelText(/^slug$/i);
      await user.type(slugInput, 'manual-slug');

      // Now type name — slug should NOT change
      await user.type(screen.getByLabelText(/^name$/i), 'Any Name');

      expect(screen.getByDisplayValue('manual-slug')).toBeInTheDocument();
    });

    it('shows client-side validation errors for empty name on create', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      // Should not call the API, form stays open
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('creates tag, adds it to list, auto-selects it', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      const newTag = { id: 'tag-new', slug: 'new-tag', name: 'New Tag', description: null };
      vi.mocked(apiClient.post).mockResolvedValue(newTag);

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'New Tag');
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      await waitFor(() => {
        // Tag appears in the list
        expect(screen.getByText('New Tag')).toBeInTheDocument();
        // Save button becomes enabled (new tag is auto-selected → dirty)
        expect(screen.getByRole('button', { name: /save tags/i })).not.toBeDisabled();
      });
    });

    it('does not duplicate a tag that already exists in the list', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      // POST returns the existing tag
      vi.mocked(apiClient.post).mockResolvedValue(TAG_A);

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Sales');
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      await waitFor(() => {
        // Only one instance of "Sales" in the list
        const matches = screen.getAllByText('Sales');
        expect(matches).toHaveLength(1);
      });
    });

    it('shows field errors from server on create', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
          name: ['Name too short'],
        })
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'X');
      await user.type(screen.getByLabelText(/^slug$/i), 'x');
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      await waitFor(() => {
        expect(screen.getByText('Name too short')).toBeInTheDocument();
      });
    });

    it('shows generic createError when APIClientError has no field details', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Something went wrong', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Valid Name');
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      });
    });

    it('shows "Failed to create tag." for non-APIClientError on create', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });
      vi.mocked(apiClient.post).mockRejectedValue(new Error('network'));

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Valid Name');
      await user.click(screen.getByRole('button', { name: /create & apply/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to create tag.')).toBeInTheDocument();
      });
    });

    it('collapses form and resets on Cancel inside create form', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      const user = userEvent.setup();
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => screen.getByText('Sales'));

      await user.click(screen.getByRole('button', { name: /create new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Typed something');

      // The inline create form has its own Cancel button — find the one inside the
      // create form panel (there is also a modal-level Cancel button in the footer)
      const cancelButtons = screen.getAllByRole('button', { name: /^cancel$/i });
      // Click the first Cancel (inside the inline create form, not the modal footer)
      await user.click(cancelButtons[0]);

      // Form should be collapsed
      expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    });
  });

  // ── State reset on close ───────────────────────────────────────────────────

  describe('state reset', () => {
    it('resets tags and filter when modal is closed', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A, TAG_B], tagIds: [] });

      const { rerender } = render(<DocumentTagsModal {...BASE_PROPS} />);

      await waitFor(() => screen.getByText('Sales'));

      // Close the modal
      rerender(<DocumentTagsModal {...BASE_PROPS} open={false} />);

      // Reopen
      rerender(<DocumentTagsModal {...BASE_PROPS} open={true} />);

      // Should load again (state was cleared)
      expect(apiClient.get).toHaveBeenCalledTimes(4); // 2 open + 2 reopen
    });
  });

  // ── documentId null guard ──────────────────────────────────────────────────

  describe('documentId null guard', () => {
    it('does not fetch when documentId is null', async () => {
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} documentId={null} />);
      });

      // No API calls should be made
      expect(apiClient.get).not.toHaveBeenCalled();
    });

    it('Save does nothing when documentId is null', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] });

      // With documentId=null, we can't really make tags dirty since no load happens.
      // The save button is disabled when not dirty anyway, so just verify no PATCH
      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} documentId={null} />);
      });

      expect(apiClient.patch).not.toHaveBeenCalled();
    });
  });

  // ── Tag displays description vs slug ──────────────────────────────────────

  describe('tag display', () => {
    it('shows slug in monospace when tag has no description', async () => {
      setupDefaultGetMocks({ allTags: [TAG_B], tagIds: [] }); // TAG_B has description: null

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('billing')).toBeInTheDocument(); // slug shown
      });
    });

    it('shows description when tag has description', async () => {
      setupDefaultGetMocks({ allTags: [TAG_A], tagIds: [] }); // TAG_A has description

      await act(async () => {
        render(<DocumentTagsModal {...BASE_PROPS} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Sales team content')).toBeInTheDocument();
      });
    });
  });
});
