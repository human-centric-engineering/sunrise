// @vitest-environment happy-dom

/**
 * ExecutionProgressInline — refused approve / reject (§124)
 *
 * A refused decision shows directly above the Confirm button that was
 * pressed, and takes focus.
 *
 * @see components/admin/orchestration/execution-progress-inline.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionProgressInline } from '@/components/admin/orchestration/execution-progress-inline';
import type { ExecutionLivePayload } from '@/lib/hooks/use-execution-live-poll';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// The real APIClientError, so the card reads the error as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/hooks/use-execution-live-poll', () => ({
  useExecutionLivePoll: <T,>(_id: string, initial: T) => ({
    ...initial,
    isPolling: false,
    lastError: null,
  }),
  isTerminalStatus: (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled',
  EXECUTION_LIVE_POLL_INTERVAL_MS: 1000,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

const TRACE: ExecutionTraceEntry[] = [
  {
    stepId: 'step-prep',
    stepType: 'llm_call',
    label: 'Prepare',
    status: 'completed',
    output: 'done',
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-15T10:00:00.000Z',
    completedAt: '2026-05-15T10:00:01.000Z',
    durationMs: 1_000,
  },
  {
    stepId: 'step-review',
    stepType: 'human_approval',
    label: 'Review',
    status: 'awaiting_approval',
    output: { prompt: 'Review the changes.' },
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-15T10:00:01.000Z',
    completedAt: '2026-05-15T10:00:01.000Z',
    durationMs: 0,
  },
];

const PAYLOAD: ExecutionLivePayload = {
  snapshot: {
    id: 'exec-1',
    status: 'paused_for_approval',
    currentStep: 'step-review',
    errorMessage: null,
    totalTokensUsed: 0,
    totalCostUsd: 0,
    startedAt: '2026-05-15T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-05-15T10:00:00.000Z',
  },
  trace: TRACE,
  costEntries: [],
  currentRunningSteps: [],
};

describe('ExecutionProgressInline — refused decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a refused approval directly above Confirm, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Execution is no longer awaiting approval', 'CONFLICT', 409)
    );
    const onApproved = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionProgressInline
        executionId="exec-1"
        initialPayload={PAYLOAD}
        onApproved={onApproved}
      />
    );

    await user.click(screen.getByRole('button', { name: /^Approve$/ }));
    const confirm = screen.getByRole('button', { name: /Confirm approval/ });
    await user.click(confirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Execution is no longer awaiting approval');
    expect(alert.parentElement?.nextElementSibling).toContainElement(confirm);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('shows a refused rejection with the server message', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Reject not allowed for this step', 'FORBIDDEN', 403)
    );
    const user = userEvent.setup();
    render(<ExecutionProgressInline executionId="exec-1" initialPayload={PAYLOAD} />);

    await user.click(screen.getByRole('button', { name: /^Reject$/ }));
    await user.type(document.getElementById('inline-reject-reason')!, 'No');
    await user.click(screen.getByRole('button', { name: /Confirm rejection/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Reject not allowed for this step');
  });
});
