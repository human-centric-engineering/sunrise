// @vitest-environment happy-dom

/**
 * ExecutionsTable — failed force-fail (§124)
 *
 * A refused force-fail shows inside its dialog, directly above its buttons,
 * takes focus, and the dialog stays open. The page sends its own fetch, so
 * the server's error envelope is read through apiErrorFromResponse.
 *
 * @see components/admin/orchestration/executions-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionsTable } from '@/components/admin/orchestration/executions-table';
import type { ExecutionListItem } from '@/types/orchestration';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/orchestration/executions',
}));

const EXECUTION: ExecutionListItem = {
  id: 'exec-001',
  workflowId: 'wf-1',
  status: 'running',
  totalTokensUsed: 0,
  totalCostUsd: 0,
  startedAt: '2026-04-18T10:00:00Z',
  createdAt: '2026-04-18T10:00:00Z',
  completedAt: null,
  workflow: { id: 'wf-1', name: 'Test Workflow' },
  timeInCurrentStepMs: null,
};

describe('ExecutionsTable — failed force-fail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'CONFLICT', message: 'Execution already finished' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the dialog open with the server message above its buttons, focused', async () => {
    const user = userEvent.setup();
    render(
      <ExecutionsTable
        initialExecutions={[EXECUTION]}
        initialMeta={{ page: 1, limit: 25, total: 1, totalPages: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /row actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /force fail/i, hidden: true }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = screen.getByRole('button', { name: /^force fail$/i });
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Execution already finished');
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
