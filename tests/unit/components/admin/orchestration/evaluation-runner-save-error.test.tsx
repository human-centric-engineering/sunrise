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
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

  it('disables Archive and Cancel while the archive runs, and a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((r) => (answer = r))
        : Promise.resolve(
            new Response(JSON.stringify({ success: true, data: { logs: [] } }), { status: 200 })
          )
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<EvaluationRunner evaluation={EVALUATION} />);

    await user.click(screen.getByRole('button', { name: /^archive$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /^archive$/i });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(confirm);
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches()).toHaveLength(1);

    // Escape while it runs is ignored: a late refusal lands inside the open dialog.
    await user.keyboard('{Escape}');
    answer(
      new Response(
        JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'Late refusal' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const alert = await within(screen.getByRole('alertdialog')).findByRole('alert');
    expect(alert).toHaveTextContent('Late refusal');

    // Closed and opened again, the dialog starts clean.
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /^cancel$/i })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^archive$/i }));
    await screen.findByRole('alertdialog');
    expect(screen.queryByText('Late refusal')).not.toBeInTheDocument();
  });

  it('clears a refused manual save once a later auto-save succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let refuse = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'PATCH') {
            return refuse
              ? new Response(
                  JSON.stringify({
                    success: false,
                    error: { code: 'CONFLICT', message: 'Could not save just now' },
                  }),
                  { status: 409, headers: { 'Content-Type': 'application/json' } }
                )
              : new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                logs: [
                  { sequenceNumber: 1, eventType: 'user_input', content: 'Q?' },
                  { sequenceNumber: 2, eventType: 'ai_response', content: 'A.' },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        })
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<EvaluationRunner evaluation={EVALUATION} />);
      await screen.findAllByText('A.');

      await user.click(screen.getByTitle('Save annotations'));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save just now');

      // An edit schedules the debounced auto-save, which now succeeds.
      refuse = false;
      await user.click(screen.getAllByText('You')[0].closest('button')!);
      await user.click(await screen.findByRole('button', { name: 'Expected' }));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a refused manual save when an auto-save that started before it then succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // PATCHes are answered by the test, in the order they were sent.
      const pending: Array<(res: Response) => void> = [];
      const ok = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'PATCH') return new Promise<Response>((r) => pending.push(r));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: {
                  logs: [
                    { sequenceNumber: 1, eventType: 'user_input', content: 'Q?' },
                    { sequenceNumber: 2, eventType: 'ai_response', content: 'A.' },
                  ],
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        })
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<EvaluationRunner evaluation={EVALUATION} />);
      await screen.findAllByText('A.');
      const save = screen.getByTitle('Save annotations');

      // Save #1 (manual) is in flight when an edit's auto-save (#2) starts.
      await user.click(save);
      await user.click(screen.getAllByText('You')[0].closest('button')!);
      await user.click(await screen.findByRole('button', { name: 'Expected' }));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await waitFor(() => expect(pending).toHaveLength(2));

      // #1 succeeds, which frees Save while #2 is still in flight.
      pending[0](ok());
      await waitFor(() => expect(save).toBeEnabled());

      // Save #3 (manual) is refused.
      await user.click(save);
      await waitFor(() => expect(pending).toHaveLength(3));
      pending[2](
        new Response(
          JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'Refused #3' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('Refused #3');

      // #2 succeeds, but it started before #3: the refusal still stands.
      pending[1](ok());
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => expect(save).toBeEnabled());
      expect(screen.getByRole('alert')).toHaveTextContent('Refused #3');
    } finally {
      vi.useRealTimers();
    }
  });
});
