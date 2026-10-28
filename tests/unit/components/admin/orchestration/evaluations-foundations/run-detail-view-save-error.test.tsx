// @vitest-environment happy-dom

/**
 * RunDetailView — refused cancel (§124)
 *
 * The cancel POST was sent with no check of its response, so a refused cancel
 * was shown nowhere. It now shows directly above the Cancel run button,
 * focused.
 *
 * @see components/admin/orchestration/evaluations-foundations/run-detail-view.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

import { RunDetailView } from '@/components/admin/orchestration/evaluations-foundations/run-detail-view';
import { API } from '@/lib/api/endpoints';

const RUN = {
  id: 'run-1',
  name: 'Smoke run',
  description: null,
  status: 'running',
  subjectKind: 'agent',
  agent: { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
  workflow: null,
  dataset: { id: 'ds-1', name: 'FAQ', caseCount: 10, contentHash: 'abc' },
  metricConfigs: [{ slug: 'exact_match', config: {} }],
  judgeProvider: null,
  judgeModel: null,
  progress: { casesTotal: 10, casesDone: 2, casesFailed: 0 },
  summary: null,
  totalCostUsd: 0,
  startedAt: '2026-05-10T10:00:00Z',
  completedAt: null,
  createdAt: '2026-05-10T09:59:00Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RunDetailView — refused cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === API.ADMIN.ORCHESTRATION.evalRunCancel('run-1')) {
          return json(
            { success: false, error: { code: 'CONFLICT', message: 'Run already finished' } },
            409
          );
        }
        if (url.startsWith(API.ADMIN.ORCHESTRATION.evalRunCases('run-1'))) {
          return json({ success: true, data: { items: [], nextCursor: null } });
        }
        return json({ success: true, data: RUN });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal directly above Cancel run, and focuses it', async () => {
    const user = userEvent.setup();
    render(<RunDetailView runId="run-1" />);

    const cancel = await screen.findByRole('button', { name: /Cancel run/i });
    await user.click(cancel);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Run already finished');
    expect(alert.nextElementSibling).toContainElement(cancel);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the refusal shown when the next poll finds the run finished and Cancel goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The run finishes as the cancel arrives: the server refuses it, and
      // every poll after that reports the run completed.
      let finished = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url === API.ADMIN.ORCHESTRATION.evalRunCancel('run-1')) {
            finished = true;
            return json(
              { success: false, error: { code: 'CONFLICT', message: 'Run is already completed' } },
              409
            );
          }
          if (url.startsWith(API.ADMIN.ORCHESTRATION.evalRunCases('run-1'))) {
            return json({ success: true, data: { items: [], nextCursor: null } });
          }
          return json({
            success: true,
            data: finished
              ? { ...RUN, status: 'completed', completedAt: '2026-05-10T10:05:00Z' }
              : RUN,
          });
        })
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<RunDetailView runId="run-1" />);

      await user.click(await screen.findByRole('button', { name: /Cancel run/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Run is already completed');

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Cancel run/i })).not.toBeInTheDocument()
      );
      expect(screen.getByRole('alert')).toHaveTextContent('Run is already completed');
    } finally {
      vi.useRealTimers();
    }
  });
});
