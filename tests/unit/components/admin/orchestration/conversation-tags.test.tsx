/**
 * ConversationTags Component Tests
 *
 * Test Coverage:
 * - Renders existing tags as badges
 * - "Add tag" button opens the input form
 * - Submitting a new tag calls apiClient.patch with the updated tags array
 * - Pressing Enter in the input submits the form
 * - Duplicate tag is ignored (handleAdd returns early if tag already in list)
 * - Empty tag is ignored (handleAdd returns early if tag is blank)
 * - Remove button on a tag calls apiClient.patch with that tag removed
 * - On patch error, tags revert to initialTags
 * - Cancel button (X) closes the add form
 * - Inputs are disabled while saving is true
 *
 * @see components/admin/orchestration/conversation-tags.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConversationTags } from '@/components/admin/orchestration/conversation-tags';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPatch = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: (...args: unknown[]) => mockPatch(...args) },
}));
vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        conversationById: (id: string) => `/api/v1/admin/orchestration/conversations/${id}`,
      },
    },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'conv-abc-123';
const INITIAL_TAGS = ['bug', 'urgent'];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationTags', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: patch resolves successfully
    mockPatch.mockResolvedValue({ success: true });
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it('renders existing tags as badges', () => {
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText('urgent')).toBeInTheDocument();
  });

  it('renders no badges when initialTags is empty', () => {
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={[]} />);

    // Only the "Add tag" button is present, no badge text
    expect(screen.queryByText('bug')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add tag/i })).toBeInTheDocument();
  });

  // ── Add tag form ───────────────────────────────────────────────────────────

  it('"Add tag" button opens the input form', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));

    expect(screen.getByPlaceholderText('Tag name')).toBeInTheDocument();
    // "Add tag" button replaced by the form
    expect(screen.queryByRole('button', { name: /add tag/i })).not.toBeInTheDocument();
  });

  it('submitting a new tag calls apiClient.patch with updated tags array', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'feature');
    // Submit via Enter key (form has onSubmit handler)
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/conversations/${CONVERSATION_ID}`,
        { body: { tags: ['bug', 'urgent', 'feature'] } }
      );
    });
  });

  it('shows the new tag after successful submission', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'feature');
    // Submit via Enter key
    await user.keyboard('{Enter}');

    expect(screen.getByText('feature')).toBeInTheDocument();
  });

  it('pressing Enter in the input submits the form', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={[]} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'newTag');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/conversations/${CONVERSATION_ID}`,
        { body: { tags: ['newTag'] } }
      );
    });
  });

  // ── Duplicate / empty guards ───────────────────────────────────────────────

  it('duplicate tag is ignored — patch not called and no duplicate badge shown', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'bug'); // already exists
    await user.keyboard('{Enter}');

    // patch should NOT be called for a duplicate
    expect(mockPatch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    // Still only one "bug" badge
    expect(screen.getAllByText('bug')).toHaveLength(1);
  });

  it('empty tag is ignored — patch not called', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    // type only whitespace
    await user.type(screen.getByPlaceholderText('Tag name'), '   ');
    await user.keyboard('{Enter}');

    expect(mockPatch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  // ── Remove tag ─────────────────────────────────────────────────────────────

  it('remove button calls apiClient.patch with the tag removed', async () => {
    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    // Remove "bug"
    await user.click(screen.getByRole('button', { name: /remove tag bug/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/conversations/${CONVERSATION_ID}`,
        { body: { tags: ['urgent'] } }
      );
    });
    // Tag visually removed
    expect(screen.queryByText('bug')).not.toBeInTheDocument();
  });

  // ── Error revert ───────────────────────────────────────────────────────────

  it('reverts to the last committed tags on patch failure and shows an error message', async () => {
    mockPatch.mockRejectedValue(new Error('Network error'));

    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    // Optimistically remove "bug"
    await user.click(screen.getByRole('button', { name: /remove tag bug/i }));

    // After the patch fails the tag should reappear and an error message shown
    await waitFor(() => {
      expect(screen.getByText('bug')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to save tags/i);
    });
  });

  it('rolls back only the failing edit — preserves prior successful edits', async () => {
    // First two patches succeed, third fails. The third failure must not wipe
    // the first two successful additions (regression guard for the previous bug
    // where rollback reset to initialTags).
    mockPatch
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Network error'));

    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={[]} />);

    // Add "alpha" (succeeds)
    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'alpha');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());

    // Add "beta" (succeeds)
    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'beta');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('beta')).toBeInTheDocument());

    // Add "gamma" (fails) — rollback must NOT wipe alpha + beta
    await user.click(screen.getByRole('button', { name: /add tag/i }));
    await user.type(screen.getByPlaceholderText('Tag name'), 'gamma');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByText('gamma')).not.toBeInTheDocument();
      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to save tags/i);
    });
  });

  // ── Cancel button ──────────────────────────────────────────────────────────

  it('cancel button (X) closes the add form', async () => {
    const user = userEvent.setup();
    // Use empty initialTags so there are no remove buttons to confuse the query
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={[]} />);

    await user.click(screen.getByRole('button', { name: /add tag/i }));
    expect(screen.getByPlaceholderText('Tag name')).toBeInTheDocument();

    // After opening the form there are two icon buttons: submit (type=submit) and cancel (type=button)
    // The cancel is the only button with type="button" in the form area
    const formButtons = screen.getAllByRole('button');
    const cancelButton = formButtons.find((btn) => btn.getAttribute('type') === 'button');
    expect(cancelButton).toBeDefined();
    await user.click(cancelButton!);

    expect(screen.queryByPlaceholderText('Tag name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add tag/i })).toBeInTheDocument();
  });

  // ── Disabled while saving ──────────────────────────────────────────────────

  it('remove buttons on tags are disabled while saving is true', async () => {
    // Keep patch pending forever so saving stays true
    mockPatch.mockReturnValue(new Promise(() => {}));

    const user = userEvent.setup();
    render(<ConversationTags conversationId={CONVERSATION_ID} initialTags={INITIAL_TAGS} />);

    // Trigger a remove — saveTags starts and saving becomes true
    // The other remove button should now be disabled
    await user.click(screen.getByRole('button', { name: /remove tag bug/i }));

    // While saving, the remaining tag's remove button is disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove tag urgent/i })).toBeDisabled();
    });
  });
});
