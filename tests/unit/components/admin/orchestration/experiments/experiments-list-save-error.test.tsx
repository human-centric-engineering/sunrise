// @vitest-environment happy-dom

/**
 * ExperimentsList — failed save (§124)
 *
 * A refused complete shows in the one box above the table, which takes focus.
 * A refused delete shows inside its dialog, which used to close and lose it.
 *
 * @see components/admin/orchestration/experiments/experiments-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExperimentsList } from '@/components/admin/orchestration/experiments/experiments-list';

// The real APIClientError, so the list reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const AGENT = { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' };

function experiment(status: string) {
  return {
    id: 'exp-1',
    name: 'Formal vs Casual',
    description: null,
    status,
    agentId: AGENT.id,
    agent: AGENT,
    variants: [
      { id: 'v1', label: 'Variant A', score: null, evaluationSession: null },
      { id: 'v2', label: 'Variant B', score: null, evaluationSession: null },
    ],
    creator: { id: 'user-1', name: 'Admin' },
    createdAt: '2025-01-15T00:00:00.000Z',
  };
}

describe('ExperimentsList — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused complete in the box above the table, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([experiment('running')]);
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Variants have no scores yet', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /^complete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Variants have no scores yet');
    expect(alert.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('keeps the delete dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([experiment('draft')]);
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Experiment is running', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExperimentsList />);

    await user.click(await screen.findByRole('button', { name: /delete experiment/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Experiment is running');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });
});
