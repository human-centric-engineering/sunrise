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
    // A bulk action names the action.
    expect(alert).toHaveTextContent("Couldn't delete the unused tags: Tag is locked");
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('re-reads the list after a bulk delete that failed part-way, so deleted tags go', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    const second: KnowledgeTagListItem = {
      ...UNUSED,
      id: 'tag-second',
      slug: 'second',
      name: 'Second',
    };
    vi.mocked(apiClient.delete)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new APIClientError('Tag is locked', 'CONFLICT', 409));
    // After the failure the server holds only the tag that could not go.
    vi.mocked(apiClient.get).mockResolvedValue([second]);
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED, second]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /delete 2 unused tags/i }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Tag is locked');
    await waitFor(() => expect(screen.queryByText('Unused Tag')).not.toBeInTheDocument());
    expect(screen.getByText('Second')).toBeInTheDocument();
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

  it('commits the delete dialog while it runs: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
    const dialog = screen.getByRole('dialog');
    const del = within(dialog).getByRole('button', { name: /^delete$/i });
    await user.click(del);

    expect(del).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(del);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late delete failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let fail: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => (fail = () => reject(new APIClientError('Boom A', 'X', 500))))
    );
    const other = { ...UNUSED, id: 'tag-other', slug: 'other', name: 'Other Tag' };
    const user = userEvent.setup();
    render(<KnowledgeTagsTable initialTags={[UNUSED, other]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /delete unused tag/i }));
    let dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    fail();

    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Unused Tag/)).toBeInTheDocument();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /delete other tag/i }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Other Tag/)).toBeInTheDocument();
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });
});
