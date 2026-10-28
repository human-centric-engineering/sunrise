// @vitest-environment happy-dom

/**
 * GenerateFromDescriptionForm — refused dataset save (§124)
 *
 * A refused save on the review step shows directly above its Save button,
 * and takes focus.
 *
 * @see components/admin/orchestration/evaluations-foundations/generate-from-description-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GenerateFromDescriptionForm } from '@/components/admin/orchestration/evaluations-foundations/generate-from-description-form';
import { API } from '@/lib/api/endpoints';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GenerateFromDescriptionForm — refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION
          ? json({
              success: true,
              data: {
                cases: [{ input: 'inp', expectedOutput: 'out', metadata: {} }],
                costUsd: 0,
                tokenUsage: { input: 1, output: 1 },
              },
            })
          : json(
              {
                success: false,
                error: { code: 'CONFLICT', message: 'A dataset with that name already exists' },
              },
              409
            )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the refusal directly above Save, and focuses it', async () => {
    const user = userEvent.setup();
    render(<GenerateFromDescriptionForm agents={[{ id: 'a-1', name: 'Bot', slug: 'bot' }]} />);

    await user.type(
      document.getElementById('gen-domain') as HTMLTextAreaElement,
      'A customer-support agent for a subscription box that handles refunds and shipping.'
    );
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    const save = await screen.findByRole('button', { name: /Save 1 case/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A dataset with that name already exists');
    expect(alert.nextElementSibling).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
