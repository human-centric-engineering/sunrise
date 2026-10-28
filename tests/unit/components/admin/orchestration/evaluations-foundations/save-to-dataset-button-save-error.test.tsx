// @vitest-environment happy-dom

/**
 * SaveToDatasetButton — refused capture (§124)
 *
 * A refused capture shows directly above the footer holding Save, takes
 * focus, and the dialog stays open.
 *
 * @see components/admin/orchestration/evaluations-foundations/save-to-dataset-button.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SaveToDatasetButton } from '@/components/admin/orchestration/evaluations-foundations/save-to-dataset-button';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SaveToDatasetButton — refused capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ success: true, data: [{ id: 'ds-1', name: 'FAQ', caseCount: 3 }] })
        )
        .mockResolvedValueOnce(
          json(
            {
              success: false,
              error: { code: 'CONFLICT', message: 'That turn is already in the dataset' },
            },
            409
          )
        )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal above the footer holding Save, focused, with the dialog open', async () => {
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await screen.findByText(/FAQ/);
    const save = screen.getByRole('button', { name: /^Save$/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That turn is already in the dataset');
    expect(screen.getByRole('dialog')).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('stays open through Escape while saving, and a refusal never reaches the next open', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ success: true, data: [{ id: 'ds-1', name: 'FAQ', caseCount: 3 }] })
        )
        .mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    );
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await screen.findByText(/FAQ/);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    answer(json({ success: false, error: { code: 'CONFLICT', message: 'Already there' } }, 409));
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('dialog')).toContainElement(alert);

    // Closed after reading it, then opened again: it starts clean.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
