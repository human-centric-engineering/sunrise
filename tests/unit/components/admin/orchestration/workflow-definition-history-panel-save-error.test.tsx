// @vitest-environment happy-dom

/**
 * WorkflowDefinitionHistoryPanel — failed rollback (§124)
 *
 * A refused rollback shows inside its dialog, directly above its buttons,
 * takes focus, and the dialog stays open.
 *
 * @see components/admin/orchestration/workflow-definition-history-panel.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowDefinitionHistoryPanel } from '@/components/admin/orchestration/workflow-definition-history-panel';

// The real APIClientError, so the panel reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const DEF = { steps: [], entryStepId: 'a', errorStrategy: 'fail' };
const VERSIONS = {
  versions: [
    {
      id: 'wfv-2',
      version: 2,
      snapshot: DEF,
      changeSummary: null,
      createdAt: '2026-05-06T12:00:00.000Z',
      createdBy: 'admin@example.test',
    },
    {
      id: 'wfv-1',
      version: 1,
      snapshot: DEF,
      changeSummary: null,
      createdAt: '2026-05-05T12:00:00.000Z',
      createdBy: 'alice@example.test',
    },
  ],
  publishedVersionId: 'wfv-2',
  nextCursor: null,
};

// Two earlier versions, so two rows can each open the dialog.
const THREE_VERSIONS = {
  ...VERSIONS,
  versions: [
    { ...VERSIONS.versions[0], id: 'wfv-3', version: 3 },
    { ...VERSIONS.versions[0], id: 'wfv-2', version: 2 },
    VERSIONS.versions[1],
  ],
  publishedVersionId: 'wfv-3',
};

/** Opens the history and row `index`'s rollback dialog. */
async function openRollback(user: ReturnType<typeof userEvent.setup>, index: number) {
  if (!screen.queryAllByRole('button', { name: /^rollback$/i }).length) {
    await user.click(screen.getByRole('button', { name: /definition history/i }));
  }
  const rows = await screen.findAllByRole('button', { name: /^rollback$/i });
  await user.click(rows[index]);
  return screen.findByRole('alertdialog');
}

describe('WorkflowDefinitionHistoryPanel — failed rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the refusal inside the open dialog, above its buttons, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(VERSIONS);
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Version snapshot is invalid', 'VALIDATION_ERROR', 400)
    );
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId="wf-1" />);

    await user.click(screen.getByRole('button', { name: /definition history/i }));
    await user.click(await screen.findByRole('button', { name: /^rollback$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirms = screen.getAllByRole('button', { name: /^rollback$/i });
    const confirm = confirms[confirms.length - 1];
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Version snapshot is invalid');
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('commits the dialog to a rollback in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(VERSIONS);
    let answer: () => void = () => {};
    vi.mocked(apiClient.post).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId="wf-1" />);

    const dialog = await openRollback(user, 0);
    await user.click(within(dialog).getByRole('button', { name: /^rollback$/i }));

    const pending = within(dialog).getByRole('button', { name: /rolling back/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(pending);
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(THREE_VERSIONS);
    let refuse: () => void = () => {};
    vi.mocked(apiClient.post).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new APIClientError('v2 snapshot is invalid', 'CONFLICT', 409));
        })
    );
    const user = userEvent.setup();
    render(<WorkflowDefinitionHistoryPanel workflowId="wf-1" />);

    let dialog = await openRollback(user, 0);
    await user.click(within(dialog).getByRole('button', { name: /^rollback$/i }));
    // Escape while the rollback runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    refuse();

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('v2 snapshot is invalid');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await openRollback(user, 1);
    expect(screen.queryByText(/v2 snapshot is invalid/)).not.toBeInTheDocument();
  });
});
