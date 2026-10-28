// @vitest-environment happy-dom

/**
 * EvaluationsTable — refused archive (§124)
 *
 * An archive the server refused with a non-OK response was shown nowhere: the
 * dialog closed and the row stayed. The refusal now shows inside the dialog,
 * which stays open.
 *
 * @see components/admin/orchestration/evaluations-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationsTable } from '@/components/admin/orchestration/evaluations-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

const EVALUATION = {
  id: 'ev-1',
  title: 'Tone Check',
  status: 'draft',
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  _count: { logs: 2 },
  createdAt: '2025-01-01T00:00:00.000Z',
};
const META = { page: 1, limit: 25, total: 1, totalPages: 1 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EvaluationsTable — refused archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? json(
              {
                success: false,
                error: { code: 'CONFLICT', message: 'Evaluation is still running' },
              },
              409
            )
          : json({ success: true, data: [EVALUATION], meta: META })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the dialog open with the server message inside it, focused', async () => {
    const user = userEvent.setup();
    render(
      <EvaluationsTable
        initialEvaluations={[EVALUATION]}
        initialMeta={META}
        agents={[{ id: 'a1', name: 'Bot A' }]}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /archive/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = screen.getByRole('button', { name: /^archive$/i });
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Evaluation is still running');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByText('Tone Check')).toBeInTheDocument();
  });
});
