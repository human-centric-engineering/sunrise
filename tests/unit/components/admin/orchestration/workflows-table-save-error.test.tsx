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
import { render, screen, waitFor } from '@testing-library/react';
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

function renderTable() {
  render(<WorkflowsTable initialWorkflows={[WORKFLOW]} initialMeta={META} />);
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
});
