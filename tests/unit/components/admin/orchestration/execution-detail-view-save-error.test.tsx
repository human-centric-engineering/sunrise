// @vitest-environment happy-dom

/**
 * ExecutionDetailView — refused actions (§124)
 *
 * A refused cancel, approve or retry shows directly above the action buttons
 * and takes focus, so a retry pressed in a trace row further down is not
 * lost off-screen. A refused rejection shows inside its dialog, which used to
 * close and show it at the top of the page.
 *
 * @see components/admin/orchestration/execution-detail-view.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionDetailView,
  type ExecutionInfo,
} from '@/components/admin/orchestration/execution-detail-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

// The real APIClientError, so the view reads the error as it would in the app.
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

function execution(status: string): ExecutionInfo {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    status,
    totalTokensUsed: 0,
    totalCostUsd: 0,
    budgetLimitUsd: null,
    currentStep: null,
    inputData: null,
    outputData: null,
    errorMessage: null,
    startedAt: '2025-01-01T10:00:00.000Z',
    completedAt: null,
    createdAt: '2025-01-01T10:00:00.000Z',
  };
}

describe('ExecutionDetailView — refused actions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({});
  });

  it('shows a refused cancel directly above the action buttons, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Execution already finished', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExecutionDetailView execution={execution('running')} trace={[]} />);

    const cancel = screen.getByRole('button', { name: /cancel execution/i });
    await user.click(cancel);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Execution already finished');
    expect(alert.nextElementSibling).toContainElement(cancel);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('gives a refused cancel with no server message its own fallback', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ExecutionDetailView execution={execution('running')} trace={[]} />);

    await user.click(screen.getByRole('button', { name: /cancel execution/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cancel failed');
  });

  it('keeps the reject dialog open with the refusal inside it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Execution is no longer awaiting approval', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ExecutionDetailView execution={execution('paused_for_approval')} trace={[]} />);

    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(screen.getByPlaceholderText(/compliance requirements/i), 'No');
    const confirms = screen.getAllByRole('button', { name: /^reject$/i });
    await user.click(confirms[confirms.length - 1]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Execution is no longer awaiting approval');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it("reports a stale retry through the hook: the action leads the server's message", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('The execution changed since you loaded it', 'STALE_RECORD', 412)
    );
    const user = userEvent.setup();
    render(
      <ExecutionDetailView
        execution={{ ...execution('failed'), errorMessage: 'LLM timeout' }}
        trace={[
          {
            stepId: 'step-fail-1',
            stepType: 'llm_call',
            label: 'Draft',
            status: 'failed',
            output: null,
            error: 'LLM timeout',
            tokensUsed: 0,
            costUsd: 0,
            startedAt: '2025-01-01T10:00:00.000Z',
            durationMs: 10,
          },
        ]}
      />
    );

    const retry = screen.getByRole('button', { name: /retry failed step/i });
    await user.click(retry);

    // The same wording every other hook-reported action gets, not a hand-built copy.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some(
            (el) => el.textContent === 'Retry failed: The execution changed since you loaded it'
          )
      ).toBe(true)
    );
  });

  it('commits the reject dialog while the rejection runs, and opens clean afterwards', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let fail: () => void = () => {};
    vi.mocked(apiClient.post).mockImplementation(
      () =>
        new Promise(
          (_r, reject) => (fail = () => reject(new APIClientError('Late refusal', 'CONFLICT', 409)))
        )
    );
    const user = userEvent.setup();
    render(<ExecutionDetailView execution={execution('paused_for_approval')} trace={[]} />);

    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    let dialog = await screen.findByRole('alertdialog');
    await user.type(screen.getByPlaceholderText(/compliance requirements/i), 'No');
    const confirm = within(dialog).getAllByRole('button', { name: /^reject$/i })[0];
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(confirm);
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    // Escape while it runs is ignored: the late refusal lands inside the open dialog.
    await user.keyboard('{Escape}');
    fail();
    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Late refusal');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    await screen.findByRole('alertdialog');
    expect(screen.queryByText('Late refusal')).not.toBeInTheDocument();
  });
});
