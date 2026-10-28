// @vitest-environment happy-dom

/**
 * GenerateCasesButton — refused save of the accepted cases (§124)
 *
 * A refused save shows directly above the footer holding Save, takes focus,
 * and the dialog stays open on the review step.
 *
 * @see components/admin/orchestration/evaluations-foundations/generate-cases-button.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GenerateCasesButton } from '@/components/admin/orchestration/evaluations-foundations/generate-cases-button';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PREVIEW = {
  success: true,
  data: {
    cases: [
      { input: 'Refund window?', expectedOutput: '30 days.', metadata: { source: 'synthetic' } },
    ],
    costUsd: 0,
    tokenUsage: { input: 1, output: 1 },
  },
};

describe('GenerateCasesButton — refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(PREVIEW))
        .mockResolvedValueOnce(
          json(
            {
              success: false,
              error: { code: 'CONFLICT', message: 'Dataset would exceed its case limit' },
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
    render(
      <GenerateCasesButton
        datasetId="ds-1"
        agents={[{ id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' }]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    const save = await screen.findByRole('button', { name: /Save 1 case/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dataset would exceed its case limit');
    expect(screen.getByRole('dialog')).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('stays open through Escape while the cases are being saved, so a refusal is still seen', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(PREVIEW))
        .mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    );
    const user = userEvent.setup();
    render(
      <GenerateCasesButton
        datasetId="ds-1"
        agents={[{ id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' }]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await user.click(await screen.findByRole('button', { name: /Save 1 case/i }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    answer(json({ success: false, error: { code: 'CONFLICT', message: 'Too many cases' } }, 409));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many cases');
    expect(screen.getByRole('dialog')).toContainElement(alert);
  });
});
