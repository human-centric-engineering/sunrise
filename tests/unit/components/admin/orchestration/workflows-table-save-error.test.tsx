// @vitest-environment happy-dom

/**
 * WorkflowsTable — failed save (§124)
 *
 * A refused row toggle or duplicate shows in the one box above the table,
 * which takes focus; a refused delete shows inside its dialog, which used to
 * close and lose it.
 *
 * @see components/admin/orchestration/workflows-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowsTable } from '@/components/admin/orchestration/workflows-table';
import type { AiWorkflowListItem } from '@/types/orchestration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the table reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const WORKFLOW = {
  id: 'wf-1',
  name: 'Alpha Flow',
  slug: 'alpha-flow',
  description: null,
  workflowDefinition: { steps: [], entryStepId: '', errorStrategy: 'fail' },
  patternsUsed: [],
  isActive: true,
  isTemplate: false,
  isSystem: false,
  metadata: null,
  createdBy: 'user-1',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  _count: { executions: 0 },
} as unknown as AiWorkflowListItem;

const META = { page: 1, limit: 25, total: 1, totalPages: 1 };

const WORKFLOW_B = {
  ...WORKFLOW,
  id: 'wf-2',
  name: 'Beta Flow',
  slug: 'beta-flow',
  createdAt: new Date('2024-12-01T00:00:00Z'),
} as unknown as AiWorkflowListItem;

function renderTable(workflows: AiWorkflowListItem[] = [WORKFLOW]) {
  render(
    <WorkflowsTable
      initialWorkflows={workflows}
      initialMeta={{ ...META, total: workflows.length }}
    />
  );
}

/** Opens row `index`'s delete dialog from its actions menu. */
async function openDelete(user: ReturnType<typeof userEvent.setup>, index: number) {
  await user.click(screen.getAllByRole('button', { name: /row actions/i })[index]);
  await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
  return screen.findByRole('alertdialog');
}

describe('WorkflowsTable — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [WORKFLOW], meta: META }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  });

  it('shows a refused toggle in the box above the table, naming the workflow, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Workflow has no published version', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('switch'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      `Couldn't update "Alpha Flow": Workflow has no published version`
    );
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the delete dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Workflow has running executions', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Workflow has running executions');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it('words a duplicate the server said nothing about as the hook does: the context, then "Try again."', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR', 0)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Couldn't duplicate "Alpha Flow"\. Try again\.$/
    );
  });

  it('commits the dialog to a delete in flight: both buttons disabled, a second click sends nothing', async () => {
    const { apiClient } = await import('@/lib/api/client');
    let answer: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve(undefined)))
    );
    const user = userEvent.setup();
    renderTable();

    const dialog = await openDelete(user, 0);
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const pending = within(dialog).getByRole('button', { name: /deleting/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(pending);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late failure in row A's dialog, never in row B's", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let refuse: () => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new APIClientError('Alpha is busy', 'CONFLICT', 409));
        })
    );
    const user = userEvent.setup();
    renderTable([WORKFLOW, WORKFLOW_B]);

    let dialog = await openDelete(user, 0);
    expect(dialog).toHaveTextContent('Alpha Flow');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    refuse();

    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Alpha Flow');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Alpha is busy');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    dialog = await openDelete(user, 1);
    expect(dialog).toHaveTextContent('Beta Flow');
    expect(screen.queryByText(/Alpha is busy/)).not.toBeInTheDocument();
  });
});
