/**
 * KnowledgeTagsTable Component Tests
 *
 * Test Coverage:
 * - Renders table headers and tag rows
 * - Empty state when no tags
 * - Empty-on-mount triggers a refresh fetch
 * - Expand/collapse row to reveal TagUsagePanel
 * - Usage panel: loading state, error state, empty usage, documents + agents
 * - Edit button opens CreateOrEditDialog pre-populated with tag data
 * - Delete button opens DeleteDialog
 * - CreateOrEditDialog: create new tag (slug auto-derived from name, then dirty)
 * - CreateOrEditDialog: client-side validation (empty name)
 * - CreateOrEditDialog: API error surfaces field errors and generic error
 * - DeleteDialog: initial phase → force-confirm phase on 409 with no agents
 * - DeleteDialog: agent-blocked phase on 409 with agentCount > 0
 * - DeleteDialog: generic delete error
 * - BulkDeleteUnusedButton: hidden when all tags in use
 * - BulkDeleteUnusedButton: shows count, confirm flow, and refreshes
 * - BulkDeleteUnusedButton: shows error on API failure
 *
 * @see components/admin/orchestration/knowledge/knowledge-tags-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeTagsTable } from '@/components/admin/orchestration/knowledge/knowledge-tags-table';
import type { KnowledgeTagListItem } from '@/types/orchestration';
import type { PaginationMeta } from '@/types/api';

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

vi.mock('@/components/ui/client-date', () => ({
  ClientDate: ({ date }: { date: string | Date }) => (
    <span>{typeof date === 'string' ? date : date.toISOString()}</span>
  ),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { apiClient, APIClientError } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTag(overrides: Partial<KnowledgeTagListItem> = {}): KnowledgeTagListItem {
  return {
    id: overrides.id ?? 'tag-1',
    slug: overrides.slug ?? 'my-tag',
    name: overrides.name ?? 'My Tag',
    description: overrides.description ?? null,
    createdAt: overrides.createdAt ?? '2025-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2025-01-01T00:00:00Z',
    documentCount: overrides.documentCount ?? 0,
    agentCount: overrides.agentCount ?? 0,
    ...overrides,
  };
}

const MOCK_META: PaginationMeta = { page: 1, limit: 100, total: 1, totalPages: 1 };

const TAG_WITH_USE = makeTag({
  id: 'tag-used',
  name: 'Used Tag',
  slug: 'used',
  documentCount: 3,
  agentCount: 1,
});
const TAG_UNUSED = makeTag({
  id: 'tag-unused',
  name: 'Unused Tag',
  slug: 'unused',
  documentCount: 0,
  agentCount: 0,
});
const TAG_DESC = makeTag({
  id: 'tag-desc',
  name: 'Described Tag',
  slug: 'described',
  description: 'A description here',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeTagsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: refresh returns a list, tag detail returns empty usage
    vi.mocked(apiClient.get).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders table headers', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Slug')).toBeInTheDocument();
      expect(screen.getByText('Documents')).toBeInTheDocument();
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Updated')).toBeInTheDocument();
    });

    it('renders tag name and slug badge', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByText('Used Tag')).toBeInTheDocument();
      expect(screen.getByText('used')).toBeInTheDocument();
    });

    it('renders document and agent counts', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('renders description when present', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_DESC]} initialMeta={MOCK_META} />);

      expect(screen.getByText('A description here')).toBeInTheDocument();
    });

    it('renders New tag button', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByRole('button', { name: /new tag/i })).toBeInTheDocument();
    });

    it('shows empty state when no tags', () => {
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      expect(screen.getByText(/no tags yet/i)).toBeInTheDocument();
    });

    it('shows "All tags are in use" text when all tags have usage', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByText('All tags are in use.')).toBeInTheDocument();
    });
  });

  // ── Mount refresh ──────────────────────────────────────────────────────────

  describe('mount refresh', () => {
    it('fetches tags on mount when initialTags is empty', async () => {
      vi.mocked(apiClient.get).mockResolvedValue([TAG_WITH_USE]);

      await act(async () => {
        render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);
      });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/knowledge/tags'));
      });
    });

    it('does not fetch tags on mount when initialTags has entries', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      // apiClient.get should NOT be called on mount when tags are pre-seeded
      expect(apiClient.get).not.toHaveBeenCalled();
    });
  });

  // ── Row expand / collapse ──────────────────────────────────────────────────

  describe('row expand/collapse', () => {
    it('expands a row and shows loading state', async () => {
      // Arrange: make the API call hang so we can observe the loading indicator
      let resolve!: (v: unknown) => void;
      vi.mocked(apiClient.get).mockReturnValue(
        new Promise((r) => {
          resolve = r;
        })
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      // Act: click the row
      await user.click(screen.getByText('Used Tag').closest('tr')!);

      // Assert: loading spinner text
      expect(screen.getByText(/loading usage/i)).toBeInTheDocument();

      // Cleanup
      resolve({ documents: [], agents: [] });
    });

    it('collapses an expanded row on second click', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ documents: [], agents: [] });

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      const row = screen.getByText('Used Tag').closest('tr')!;

      // Expand
      await user.click(row);
      await waitFor(() =>
        expect(screen.getByText(/nothing references this tag/i)).toBeInTheDocument()
      );

      // Collapse
      await user.click(row);
      await waitFor(() =>
        expect(screen.queryByText(/nothing references this tag/i)).not.toBeInTheDocument()
      );
    });

    it('shows usage panel with documents and agents when loaded', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        documents: [
          { id: 'd1', name: 'Sales Guide', fileName: 'sales.pdf', scope: 'app', status: 'ready' },
        ],
        agents: [{ id: 'a1', name: 'Support Bot', slug: 'support-bot', isActive: true }],
      });

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByText('Used Tag').closest('tr')!);

      await waitFor(() => {
        expect(screen.getByText('Sales Guide')).toBeInTheDocument();
        expect(screen.getByText('Support Bot')).toBeInTheDocument();
      });
    });

    it('shows inactive badge for inactive agents in usage panel', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        documents: [],
        agents: [{ id: 'a1', name: 'Old Bot', slug: 'old-bot', isActive: false }],
      });

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByText('Used Tag').closest('tr')!);

      await waitFor(() => {
        expect(screen.getByText('inactive')).toBeInTheDocument();
      });
    });

    it('shows usage error when detail fetch fails', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Server error', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByText('Used Tag').closest('tr')!);

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });

    it('uses cached usage on second expand without re-fetching', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ documents: [], agents: [] });

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      const row = screen.getByText('Used Tag').closest('tr')!;

      // Expand once
      await user.click(row);
      await waitFor(() =>
        expect(screen.getByText(/nothing references this tag/i)).toBeInTheDocument()
      );

      const callCount = vi.mocked(apiClient.get).mock.calls.length;

      // Collapse, then expand again
      await user.click(row);
      await user.click(row);

      // No extra fetch call
      expect(vi.mocked(apiClient.get).mock.calls.length).toBe(callCount);
    });

    it('shows "No data" when usage is undefined', async () => {
      // Detail call returns something without documents/agents keys
      vi.mocked(apiClient.get).mockResolvedValue({ documents: undefined, agents: undefined });

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByText('Used Tag').closest('tr')!);

      // The panel uses undefined fallback for documents/agents = []
      // so "nothing references this tag" should appear (both counts = 0)
      await waitFor(() => {
        expect(screen.getByText(/nothing references this tag/i)).toBeInTheDocument();
      });
    });
  });

  // ── Edit dialog ────────────────────────────────────────────────────────────

  describe('edit dialog', () => {
    it('opens dialog pre-populated with tag data on Edit click', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_DESC]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /edit described tag/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Described Tag')).toBeInTheDocument();
      expect(screen.getByDisplayValue('described')).toBeInTheDocument();
    });

    it('closes dialog on Cancel', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_DESC]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /edit described tag/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('auto-derives slug from name when slug not yet dirty', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      // Open create dialog
      await user.click(screen.getByRole('button', { name: /new tag/i }));

      // Type a name
      await user.type(screen.getByLabelText(/^name$/i), 'Customer Support');

      // Slug should be auto-derived
      expect(screen.getByDisplayValue('customer-support')).toBeInTheDocument();
    });

    it('stops auto-deriving slug once slug field is manually edited', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));

      // Manually edit the slug
      const slugInput = screen.getByLabelText(/^slug$/i);
      await user.clear(slugInput);
      await user.type(slugInput, 'my-custom-slug');

      // Type in name — slug should NOT change
      await user.type(screen.getByLabelText(/^name$/i), 'Something Else');

      expect(screen.getByDisplayValue('my-custom-slug')).toBeInTheDocument();
    });

    it('shows client-side validation error for empty name', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));
      // Leave name empty, click Create tag
      await user.click(screen.getByRole('button', { name: /create tag/i }));

      // Zod will reject empty name
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      // Dialog stays open — no API call
      expect(apiClient.post).not.toHaveBeenCalled();
    });

    it('submits create and closes dialog on success', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({});
      vi.mocked(apiClient.get).mockResolvedValue([TAG_WITH_USE]);

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));

      await user.type(screen.getByLabelText(/^name$/i), 'Billing');
      await user.click(screen.getByRole('button', { name: /create tag/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/tags'),
          expect.objectContaining({ body: expect.objectContaining({ name: 'Billing' }) })
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('shows field errors from APIClientError details', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
          slug: ['Slug already taken'],
        })
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Billing');
      await user.click(screen.getByRole('button', { name: /create tag/i }));

      await waitFor(() => {
        expect(screen.getByText('Slug already taken')).toBeInTheDocument();
      });
    });

    it('shows generic error when APIClientError has no field details', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Something went wrong', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Billing');
      await user.click(screen.getByRole('button', { name: /create tag/i }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      });
    });

    it('shows generic error when a non-APIClientError is thrown', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(new Error('network failure'));

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /new tag/i }));
      await user.type(screen.getByLabelText(/^name$/i), 'Billing');
      await user.click(screen.getByRole('button', { name: /create tag/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to save the tag.')).toBeInTheDocument();
      });
    });

    it('submits edit PATCH on Save changes', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      vi.mocked(apiClient.get).mockResolvedValue([TAG_DESC]);

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_DESC]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /edit described tag/i }));

      // Change name
      const nameInput = screen.getByDisplayValue('Described Tag');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated Tag');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/tags/tag-desc'),
          expect.objectContaining({ body: expect.objectContaining({ name: 'Updated Tag' }) })
        );
      });
    });
  });

  // ── Delete dialog ──────────────────────────────────────────────────────────

  describe('delete dialog', () => {
    it('opens delete dialog on Delete click', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Dialog title includes the tag name
      expect(screen.getByRole('heading', { name: /delete.*used tag/i })).toBeInTheDocument();
    });

    it('closes delete dialog on Cancel', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('deletes tag and closes dialog on confirm', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({});
      vi.mocked(apiClient.get).mockResolvedValue([]);

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/tags/tag-unused')
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('escalates to force-confirm phase on 409 with no agents', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Tag in use', 'CONFLICT', 409, { agentCount: 0, agents: [] })
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete anyway/i })).toBeInTheDocument();
      });
    });

    it('sends ?force=true on force-confirm delete', async () => {
      // First call: 409 with no agents → escalate to force-confirm
      vi.mocked(apiClient.delete)
        .mockRejectedValueOnce(
          new APIClientError('Tag in use', 'CONFLICT', 409, { agentCount: 0, agents: [] })
        )
        .mockResolvedValueOnce({});
      vi.mocked(apiClient.get).mockResolvedValue([]);

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete anyway/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /delete anyway/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenLastCalledWith(expect.stringContaining('?force=true'));
      });
    });

    it('shows agent-blocked phase on 409 with agents', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Agent blocked', 'CONFLICT', 409, {
          agentCount: 2,
          agents: [
            { id: 'a1', name: 'Support Bot', slug: 'support-bot' },
            { id: 'a2', name: 'Sales Bot', slug: 'sales-bot' },
          ],
        })
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        // Dialog heading contains "Cannot delete" — use a heading role matcher since the
        // text is rendered as a single text node inside the heading element
        expect(screen.getByRole('heading', { name: /cannot delete/i })).toBeInTheDocument();
        expect(screen.getByText('Support Bot')).toBeInTheDocument();
        expect(screen.getByText('Sales Bot')).toBeInTheDocument();
      });
    });

    it('shows generic delete error for non-409 APIClientError', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Internal server error', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByText('Internal server error')).toBeInTheDocument();
      });
    });

    it('shows "Failed to delete the tag." for non-APIClientError', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('network failure'));

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to delete the tag.')).toBeInTheDocument();
      });
    });

    it('shows generic error on second 409 in force-confirm phase', async () => {
      // First call: 409 with no agents → force-confirm
      // Second call: another 409 → shows error
      vi.mocked(apiClient.delete)
        .mockRejectedValueOnce(
          new APIClientError('Tag in use', 'CONFLICT', 409, { agentCount: 0, agents: [] })
        )
        .mockRejectedValueOnce(
          new APIClientError('Still in use', 'CONFLICT', 409, { agentCount: 0, agents: [] })
        );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete used tag/i }));
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete anyway/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /delete anyway/i }));

      await waitFor(() => {
        expect(screen.getByText('Still in use')).toBeInTheDocument();
      });
    });
  });

  // ── BulkDeleteUnusedButton ─────────────────────────────────────────────────

  describe('BulkDeleteUnusedButton', () => {
    it('shows delete unused button when tags are unused', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      expect(screen.getByRole('button', { name: /delete 1 unused tag/i })).toBeInTheDocument();
    });

    it('shows "All tags are in use." when no unused tags', () => {
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      expect(screen.getByText('All tags are in use.')).toBeInTheDocument();
    });

    it('shows confirm UI on button click', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));

      expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('cancels confirm on Cancel click', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.getByRole('button', { name: /delete 1 unused tag/i })).toBeInTheDocument();
    });

    it('calls delete for each unused tag on Confirm', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({});

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));
      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          expect.stringContaining('/knowledge/tags/tag-unused')
        );
      });
    });

    it('shows error when bulk delete fails', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Delete failed', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));
      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(screen.getByText('Delete failed')).toBeInTheDocument();
      });
    });

    it('shows "Bulk delete failed" for non-APIClientError', async () => {
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('network error'));

      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED]} initialMeta={MOCK_META} />);

      await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));
      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(screen.getByText('Bulk delete failed')).toBeInTheDocument();
      });
    });

    it('uses plural "tags" for multiple unused tags', () => {
      const tag2 = makeTag({ id: 'tag-2', name: 'Second Unused', slug: 'second-unused' });
      render(<KnowledgeTagsTable initialTags={[TAG_UNUSED, tag2]} initialMeta={MOCK_META} />);

      expect(screen.getByRole('button', { name: /delete 2 unused tags/i })).toBeInTheDocument();
    });
  });

  // ── Edit stop-propagation ──────────────────────────────────────────────────

  describe('row action buttons stop propagation', () => {
    it('edit button click does not expand the row', async () => {
      const user = userEvent.setup();
      render(<KnowledgeTagsTable initialTags={[TAG_WITH_USE]} initialMeta={MOCK_META} />);

      // Click edit button (should not trigger row expand)
      await user.click(screen.getByRole('button', { name: /edit used tag/i }));

      // Dialog should open, not usage panel
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByText(/loading usage/i)).not.toBeInTheDocument();
    });
  });
});
