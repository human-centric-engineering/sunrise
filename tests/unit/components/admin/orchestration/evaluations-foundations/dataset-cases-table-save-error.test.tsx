// @vitest-environment happy-dom

/**
 * DatasetCasesTable — refused case edit (§124)
 *
 * A refused edit shows directly above the dialog's footer holding Save,
 * takes focus, and the dialog stays open.
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-cases-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DatasetCasesTable } from '@/components/admin/orchestration/evaluations-foundations/dataset-cases-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe('DatasetCasesTable — refused edit', () => {
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
              error: { code: 'CONFLICT', message: 'Dataset is locked by a running evaluation' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal above the footer holding Save, focused, with the dialog open', async () => {
    const user = userEvent.setup();
    render(
      <DatasetCasesTable
        datasetId="ds-1"
        initialCases={[{ id: 'c-0', position: 0, input: 'Refund window?', expectedOutput: null }]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Edit case 0/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(document.getElementById('edit-expected')!, '30 days');
    const save = screen.getByRole('button', { name: /^Save$/ });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dataset is locked by a running evaluation');
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
