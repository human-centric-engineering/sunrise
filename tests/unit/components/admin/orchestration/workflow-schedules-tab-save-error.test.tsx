// @vitest-environment happy-dom

/**
 * WorkflowSchedulesTab — failed save (§124)
 *
 * A toggle refused for any reason but staleness used to be silent, and a
 * refused delete closed its dialog and was shown nowhere. The toggle now
 * shows in the box above the list; the delete inside its dialog, which stays
 * open.
 *
 * @see components/admin/orchestration/workflow-schedules-tab.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowSchedulesTab } from '@/components/admin/orchestration/workflow-schedules-tab';

// The real APIClientError, so the tab reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const SCHEDULES = {
  schedules: [
    {
      id: 'sched-1',
      name: 'Daily Morning Run',
      cronExpression: '0 9 * * *',
      isEnabled: true,
      nextRunAt: null,
      lastRunAt: null,
      inputTemplate: null,
      createdAt: '2026-01-01T00:00:00Z',
      version: '"v1"',
    },
  ],
};

const TWO_SCHEDULES = {
  schedules: [
    SCHEDULES.schedules[0],
    { ...SCHEDULES.schedules[0], id: 'sched-2', name: 'Weekly Digest', version: '"v2"' },
  ],
};

describe('WorkflowSchedulesTab — failed save', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(SCHEDULES);
  });

  it('shows a refused toggle in the box above the list, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Schedule limit reached', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    const toggle = await screen.findByRole('switch', { name: /toggle daily morning run/i });
    await user.click(toggle);

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t update "Daily Morning Run": Schedule limit reached');
    expect(alert.compareDocumentPosition(screen.getByText('Daily Morning Run'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the delete dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Schedule is running', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await user.click(await screen.findByTitle(/delete schedule/i));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Schedule is running');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it('commits the dialog to a delete in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await user.click(await screen.findByTitle(/delete schedule/i));
    const dialog = await screen.findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: /^delete$/i });
    await user.click(action);

    expect(action).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(action);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(TWO_SCHEDULES);
    let refuse: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new APIClientError('Morning run is busy', 'CONFLICT', 409));
        })
    );
    const user = userEvent.setup();
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await screen.findByText('Weekly Digest');
    await user.click(screen.getAllByTitle(/delete schedule/i)[0]);
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Daily Morning Run');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    refuse();

    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Daily Morning Run');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Morning run is busy');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByTitle(/delete schedule/i)[1]);
    dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Weekly Digest');
    expect(screen.queryByText(/Morning run is busy/)).not.toBeInTheDocument();
  });
});
