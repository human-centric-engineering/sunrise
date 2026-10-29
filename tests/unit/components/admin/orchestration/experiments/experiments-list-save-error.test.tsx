// @vitest-environment happy-dom

/**
 * ExperimentsList — failed save (§124)
 *
 * A refused complete shows in the one box above the table, which takes focus.
 * A refused delete shows inside its dialog, which used to close and lose it.
 *
 * @see components/admin/orchestration/experiments/experiments-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExperimentsList } from '@/components/admin/orchestration/experiments/experiments-list';

// The real APIClientError, so the list reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const AGENT = { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' };

function experiment(status: string, id = 'exp-1', name = 'Formal vs Casual') {
  return {
    id,
    name,
    description: null,
    status,
    agentId: AGENT.id,
    agent: AGENT,
    variants: [
      { id: 'v1', label: 'Variant A', score: null, evaluationSession: null },
      { id: 'v2', label: 'Variant B', score: null, evaluationSession: null },
    ],
    creator: { id: 'user-1', name: 'Admin' },
    createdAt: '2025-01-15T00:00:00.000Z',
  };
}

describe('ExperimentsList — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused complete in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([experiment('running')]);
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Variants have no scores yet', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /^complete$/i }));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent(
      'Couldn\'t complete "Formal vs Casual": Variants have no scores yet'
    );
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the delete dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([experiment('draft')]);
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Experiment is running', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /delete experiment/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Experiment is running');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it('disables Delete and Cancel while the delete runs, and a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([experiment('draft')]);
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((r) => (answer = () => r(undefined)))
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /delete experiment/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const pending = within(dialog).getByRole('button', { name: /deleting/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(pending);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it("keeps row A's late failure in its own dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([
      experiment('draft'),
      experiment('draft', 'exp-2', 'Short vs Long'),
    ]);
    let fail: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise(
          (_r, reject) => (fail = () => reject(new APIClientError('Boom A', 'CONFLICT', 409)))
        )
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click((await screen.findAllByRole('button', { name: /delete experiment/i }))[0]);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    fail();

    dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Formal vs Casual')).toBeInTheDocument();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /delete experiment/i })[1]);
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Short vs Long')).toBeInTheDocument();
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });

  it('blocks a blank variant label by Save, focused on it, before any request (t-964)', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockImplementation((url: string) =>
      Promise.resolve(url.includes('/agents') ? [AGENT] : [])
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /new experiment/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\. Formal vs casual tone/i), 'New Exp');
    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Support Bot' }));
    const second = screen.getByPlaceholderText('Variant 2 label');
    await user.clear(second);

    const create = screen.getByRole('button', { name: /create experiment/i });
    await user.click(create);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Variant 2 needs a label.');
    expect(alert.nextElementSibling).toContainElement(create);
    await waitFor(() => expect(second).toHaveFocus());
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
