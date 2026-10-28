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
import { render, screen, waitFor } from '@testing-library/react';
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
    expect(alert).toHaveTextContent('Schedule limit reached');
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
});
