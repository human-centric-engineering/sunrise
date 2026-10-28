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
import { render, screen, waitFor, within } from '@testing-library/react';
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

  describe('while the archive is in flight', () => {
    const SECOND = { ...EVALUATION, id: 'ev-2', title: 'Accuracy Check' };
    const META_2 = { ...META, total: 2 };
    let answer: (res: Response) => void = () => {};
    const patches = () =>
      vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH');

    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
          init?.method === 'PATCH'
            ? new Promise<Response>((r) => (answer = r))
            : Promise.resolve(json({ success: true, data: [EVALUATION, SECOND], meta: META_2 }))
        )
      );
    });

    function renderTable() {
      render(
        <EvaluationsTable
          initialEvaluations={[EVALUATION, SECOND]}
          initialMeta={META_2}
          agents={[{ id: 'a1', name: 'Bot A' }]}
        />
      );
    }

    async function openArchive(user: ReturnType<typeof userEvent.setup>, row: number) {
      await user.click(screen.getAllByRole('button', { name: /actions/i })[row]);
      await user.click(await screen.findByRole('menuitem', { name: /archive/i }));
      return screen.findByRole('alertdialog');
    }

    it('disables Archive and Cancel, and a second click sends nothing', async () => {
      const user = userEvent.setup();
      renderTable();
      const dialog = await openArchive(user, 0);
      const confirm = within(dialog).getByRole('button', { name: /^archive$/i });
      await user.click(confirm);

      expect(confirm).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
      await user.click(confirm);
      expect(patches()).toHaveLength(1);

      answer(json({ success: true, data: { id: 'ev-1' } }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(patches()).toHaveLength(1);
    });

    it("keeps row A's late failure in its own dialog, never in row B's", async () => {
      const user = userEvent.setup();
      renderTable();
      let dialog = await openArchive(user, 0);
      await user.click(within(dialog).getByRole('button', { name: /^archive$/i }));
      // Escape while the archive runs is ignored: the dialog waits for the answer.
      await user.keyboard('{Escape}');
      answer(json({ success: false, error: { code: 'CONFLICT', message: 'Boom A' } }, 409));

      dialog = screen.getByRole('alertdialog');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

      await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      dialog = await openArchive(user, 1);
      expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
    });
  });
});
