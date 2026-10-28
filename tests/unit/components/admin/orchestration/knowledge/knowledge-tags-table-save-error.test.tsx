// @vitest-environment happy-dom

/**
 * KnowledgeTagsTable — failed saves (§124)
 *
 * The bulk delete is a list action: its failure shows in the one save error
 * directly above the table, which takes focus. The create / edit dialog shows
 * its failure above its buttons, and a field the server named gets its
 * message under that input and the focus.
 *
 * @see components/admin/orchestration/knowledge/knowledge-tags-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeTagsTable } from '@/components/admin/orchestration/knowledge/knowledge-tags-table';
import type { KnowledgeTagListItem } from '@/types/orchestration';

// The real APIClientError, so the table reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const UNUSED: KnowledgeTagListItem = {
  id: 'tag-unused',
  slug: 'unused',
  name: 'Unused Tag',
  description: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  documentCount: 0,
  agentCount: 0,
};
const META = { page: 1, limit: 100, total: 1, totalPages: 1 };

describe('KnowledgeTagsTable — failed saves', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([]);
  });

  it('shows a failed bulk delete directly above the table and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Tag is locked', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /delete 1 unused tag/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Tag is locked');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('puts a field the server named under its input, focuses it, and keeps the dialog open', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'slug', message: 'Slug already taken' }],
      })
    );
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /new tag/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Billing');
    await user.click(screen.getByRole('button', { name: /create tag/i }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Slug already taken')).toBeInTheDocument();
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('1 field needs fixing.');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /create tag/i })
    );
    await waitFor(() => expect(within(dialog).getByLabelText(/^slug$/i)).toHaveFocus());
  });

  it('keeps the delete dialog open with a failed delete above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Internal server error', 'INTERNAL_ERROR', 500)
    );
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Internal server error');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^delete$/i })
    );
    expect(alert).toHaveFocus();
  });
});
