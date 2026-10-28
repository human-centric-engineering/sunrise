// @vitest-environment happy-dom

/**
 * RunCreateForm — refused queue (§124)
 *
 * A refused queue shows directly above the row holding Queue run, focused.
 *
 * @see components/admin/orchestration/evaluations-foundations/run-create-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

import { RunCreateForm } from '@/components/admin/orchestration/evaluations-foundations/run-create-form';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RunCreateForm — refused queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/runs/estimate')
          ? json({
              success: true,
              data: {
                midUsd: 0,
                lowUsd: 0,
                highUsd: 0,
                basedOn: 'heuristic',
                sampleSize: 0,
                caseCount: 0,
                modelMix: [],
                notes: 'no cases',
              },
            })
          : json(
              {
                success: false,
                error: { code: 'CONFLICT', message: 'Too many runs queued for this dataset' },
              },
              409
            )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal directly above the row holding Queue run, and focuses it', async () => {
    const user = userEvent.setup();
    render(
      <RunCreateForm
        agents={[{ id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' }]}
        datasets={[{ id: 'ds-1', name: 'FAQ', caseCount: 10 }]}
        heuristicGraders={[
          {
            slug: 'exact_match',
            family: 'heuristic',
            description: 'Exact match check',
            referenceRequired: true,
            defaultConfig: { normalise: true },
          },
        ]}
        judgeAgents={[]}
      />
    );

    await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
    await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
    const queue = screen.getByRole('button', { name: /queue run/i });
    await user.click(queue);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many runs queued for this dataset');
    expect(alert.nextElementSibling).toContainElement(queue);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
