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
import { render, screen, waitFor } from '@testing-library/react';
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
});
