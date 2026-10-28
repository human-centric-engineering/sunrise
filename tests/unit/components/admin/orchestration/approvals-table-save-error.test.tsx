// @vitest-environment happy-dom

/**
 * ApprovalsTable — failed approve / reject (§124)
 *
 * A refused approve or reject shows inside its dialog, directly above its
 * buttons, takes focus, and the dialog stays open. The page sends its own
 * fetch, so the server's error envelope is read through apiErrorFromResponse.
 *
 * @see components/admin/orchestration/approvals-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApprovalsTable } from '@/components/admin/orchestration/approvals-table';
import type { ExecutionListItem } from '@/types/orchestration';

const APPROVAL: ExecutionListItem = {
  id: 'exec-001',
  workflowId: 'wf-1',
  status: 'paused_for_approval',
  totalTokensUsed: 0,
  totalCostUsd: 0,
  startedAt: '2026-04-28T10:00:00Z',
  createdAt: '2026-04-28T10:00:00Z',
  completedAt: null,
  workflow: { id: 'wf-1', name: 'Compliance Review' },
  timeInCurrentStepMs: null,
};
const META = { page: 1, limit: 25, total: 1, totalPages: 1 };

function errorResponse(message: string, status = 409) {
  return new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApprovalsTable — failed approve / reject', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the approve dialog open with the server message above its buttons, focused', async () => {
    fetchMock.mockResolvedValue(errorResponse('Execution is no longer awaiting approval'));
    const user = userEvent.setup();
    render(<ApprovalsTable initialApprovals={[APPROVAL]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirms = screen.getAllByRole('button', { name: /^approve$/i });
    const confirm = confirms[confirms.length - 1];
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Execution is no longer awaiting approval');
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the reject dialog open with the server message inside it', async () => {
    fetchMock.mockResolvedValue(errorResponse('Reject is not allowed for this step', 403));
    const user = userEvent.setup();
    render(<ApprovalsTable initialApprovals={[APPROVAL]} initialMeta={META} />);

    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(screen.getByPlaceholderText(/compliance requirements/i), 'No');
    const confirms = screen.getAllByRole('button', { name: /^reject$/i });
    await user.click(confirms[confirms.length - 1]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Reject is not allowed for this step');
    expect(dialog).toContainElement(alert);
  });
});
