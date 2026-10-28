// @vitest-environment happy-dom

/**
 * ConversationTags — failed save (§124)
 *
 * A refused tag save rolls back and shows the server's message above the tags,
 * taking focus; it used to show a fixed message below them, unfocused.
 *
 * @see components/admin/orchestration/conversation-tags.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConversationTags } from '@/components/admin/orchestration/conversation-tags';

// The real APIClientError, so the failure is read as it would be in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('ConversationTags — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows the server's message above the tags, focuses it, and rolls back", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Tags must be 50 characters or fewer', 'VALIDATION_ERROR', 400)
    );
    const user = userEvent.setup();
    render(<ConversationTags conversationId="conv-1" initialTags={['billing']} />);

    await user.click(screen.getByRole('button', { name: 'Remove tag billing' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Tags must be 50 characters or fewer');
    expect(alert.nextElementSibling).toHaveTextContent('billing');
    expect(alert).toHaveFocus();
  });
});
