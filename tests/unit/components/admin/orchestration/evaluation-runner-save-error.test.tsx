// @vitest-environment happy-dom

/**
 * EvaluationRunner — refused annotation save and archive (§124)
 *
 * A press of Save the server refused, and a refused archive, were both shown
 * nowhere. Save's refusal now shows beside the button; the archive's inside
 * its dialog, which stays open.
 *
 * @see components/admin/orchestration/evaluation-runner.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

import { EvaluationRunner } from '@/components/admin/orchestration/evaluation-runner';

const EVALUATION = {
  id: 'ev-2',
  title: 'Running Eval',
  status: 'in_progress',
  summary: null,
  improvementSuggestions: null,
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: null,
  metadata: null,
};

function refusing(message: string) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'PATCH'
      ? new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response(JSON.stringify({ success: true, data: { logs: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
  );
}

describe('EvaluationRunner — refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a refused manual save beside the Save button, and focuses it', async () => {
    vi.stubGlobal('fetch', refusing('Evaluation was archived elsewhere'));
    const user = userEvent.setup();
    render(<EvaluationRunner evaluation={EVALUATION} />);

    const save = screen.getByTitle('Save annotations');
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Evaluation was archived elsewhere');
    // Directly under the header holding Save.
    expect(alert.parentElement?.previousElementSibling).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the archive dialog open with the refusal inside it', async () => {
    vi.stubGlobal('fetch', refusing('Evaluation is being completed'));
    const user = userEvent.setup();
    render(<EvaluationRunner evaluation={EVALUATION} />);

    await user.click(screen.getByRole('button', { name: /^archive$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirms = screen.getAllByRole('button', { name: /^archive$/i });
    await user.click(confirms[confirms.length - 1]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Evaluation is being completed');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });
});
