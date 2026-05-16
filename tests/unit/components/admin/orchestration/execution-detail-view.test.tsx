/**
 * Unit Test: ExecutionDetailView
 *
 * @see components/admin/orchestration/execution-detail-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionDetailView,
  type ExecutionInfo,
} from '@/components/admin/orchestration/execution-detail-view';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockPost = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
    get: vi.fn().mockResolvedValue({}),
  },
  APIClientError: class extends Error {},
}));

// Pass the initial payload straight through — these tests don't exercise
// the live-polling behaviour, which has its own test file.
vi.mock('@/lib/hooks/use-execution-live-poll', () => ({
  useExecutionLivePoll: <T extends { snapshot: { status: string } }>(_id: string, initial: T) => ({
    ...initial,
    isPolling: !(['completed', 'failed', 'cancelled'] as const).includes(
      initial.snapshot.status as 'completed' | 'failed' | 'cancelled'
    ),
    lastError: null,
  }),
  isTerminalStatus: (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled',
  EXECUTION_LIVE_POLL_INTERVAL_MS: 1000,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_EXECUTION: ExecutionInfo = {
  id: 'cmjbv4i3x00003wsloputgwu9',
  workflowId: 'cmjbv4i3x00003wsloputgwu2',
  status: 'completed',
  totalTokensUsed: 1500,
  totalCostUsd: 0.075,
  budgetLimitUsd: null,
  currentStep: null,
  inputData: null,
  outputData: null,
  errorMessage: null,
  startedAt: '2025-01-01T10:00:00.000Z',
  completedAt: '2025-01-01T10:01:30.000Z',
  createdAt: '2025-01-01T10:00:00.000Z',
};

function makeExecution(overrides: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return { ...BASE_EXECUTION, ...overrides };
}

const TRACE_ENTRY: ExecutionTraceEntry = {
  stepId: 'step-1',
  stepType: 'llm',
  label: 'Generate response',
  status: 'completed',
  output: { result: 'done' },
  error: undefined,
  tokensUsed: 300,
  costUsd: 0.01,
  startedAt: '2025-01-01T10:00:00.000Z',
  completedAt: '2025-01-01T10:00:01.000Z',
  durationMs: 450,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Status badge', () => {
    it('renders the status badge with formatted text', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[]} />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('renders "Failed" badge for failed status', () => {
      render(<ExecutionDetailView execution={makeExecution({ status: 'failed' })} trace={[]} />);

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('formats underscored status as sentence-case', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval' })}
          trace={[]}
        />
      );

      expect(screen.getByText('Paused for approval')).toBeInTheDocument();
    });
  });

  describe('Summary cards', () => {
    it('renders total tokens with locale formatting', () => {
      render(
        <ExecutionDetailView execution={makeExecution({ totalTokensUsed: 12345 })} trace={[]} />
      );

      expect(screen.getByText('12,345')).toBeInTheDocument();
    });

    it('renders total cost formatted to 4 decimal places', () => {
      render(<ExecutionDetailView execution={makeExecution({ totalCostUsd: 0.075 })} trace={[]} />);

      expect(screen.getByText('$0.0750')).toBeInTheDocument();
    });

    it('renders em-dash for budget when budgetLimitUsd is null', () => {
      render(
        <ExecutionDetailView execution={makeExecution({ budgetLimitUsd: null })} trace={[]} />
      );

      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  describe('Budget bar', () => {
    it('renders budget amount and usage bar when budgetLimitUsd is set', () => {
      const { container } = render(
        <ExecutionDetailView
          execution={makeExecution({ budgetLimitUsd: 1.0, totalCostUsd: 0.5 })}
          trace={[]}
        />
      );

      expect(screen.getByText('$1.00')).toBeInTheDocument();
      expect(screen.getByText('50.0% used')).toBeInTheDocument();

      // A filled bar should be present
      const bars = container.querySelectorAll('.bg-green-500, .bg-amber-500, .bg-red-500');
      expect(bars.length).toBeGreaterThanOrEqual(1);
    });

    it('uses red bar styling when budget usage exceeds 90%', () => {
      const { container } = render(
        <ExecutionDetailView
          execution={makeExecution({ budgetLimitUsd: 1.0, totalCostUsd: 0.95 })}
          trace={[]}
        />
      );

      const redBar = container.querySelector('.bg-red-500');
      expect(redBar).toBeTruthy();
    });
  });

  describe('Failure synopsis (replaces the legacy bare error banner)', () => {
    // The bare red-banner-on-any-errorMessage behaviour was replaced by
    // the structured ExecutionStatusSynopsis. Synopsis-internal logic
    // (retry timeline, predecessor output, expand/collapse, no-render
    // on clean completions) is covered in `execution-status-synopsis.test.tsx`;
    // these tests only verify the integration point in the detail view.

    it('renders the failure synopsis when status=failed with errorMessage', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'failed', errorMessage: 'Step 3 timed out' })}
          trace={[]}
        />
      );

      expect(screen.getByTestId('execution-synopsis-failure')).toBeInTheDocument();
      expect(screen.getByText('Step 3 timed out')).toBeInTheDocument();
    });

    it('renders nothing for the synopsis on clean completions', () => {
      render(<ExecutionDetailView execution={makeExecution({ errorMessage: null })} trace={[]} />);

      // No failure or cancellation panel — completed run with no skips.
      expect(screen.queryByTestId('execution-synopsis-failure')).not.toBeInTheDocument();
      expect(screen.queryByTestId('execution-synopsis-cancellation')).not.toBeInTheDocument();
      expect(screen.queryByTestId('execution-synopsis-skips')).not.toBeInTheDocument();
    });

    it('renders nothing when status=completed even if a stray errorMessage is set', () => {
      // status=completed + errorMessage shouldn't surface a red banner —
      // the engine only writes errorMessage on failed/cancelled paths
      // post-2026-05-16, but we defend the synopsis against legacy rows
      // that may have both set.
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'completed', errorMessage: 'old stale message' })}
          trace={[]}
        />
      );

      expect(screen.queryByTestId('execution-synopsis-failure')).not.toBeInTheDocument();
    });
  });

  describe('Input/Output cards', () => {
    it('renders Input Data collapsible card when inputData is present', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ inputData: { prompt: 'hello' } })}
          trace={[]}
        />
      );

      const inputButton = screen.getByRole('button', { name: /^input data$/i });
      expect(inputButton).toBeInTheDocument();

      // Click to expand
      await user.click(inputButton);
      expect(screen.getByText(/"prompt"/)).toBeInTheDocument();
    });

    it('does not render Input Data card when inputData is null', () => {
      render(<ExecutionDetailView execution={makeExecution({ inputData: null })} trace={[]} />);

      expect(screen.queryByRole('button', { name: /^input data$/i })).not.toBeInTheDocument();
    });
  });

  describe('Step timeline', () => {
    it('shows "No trace entries recorded." when trace is empty', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[]} />);

      expect(screen.getByText('No trace entries recorded.')).toBeInTheDocument();
    });

    it('renders trace entry rows for each trace entry', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[TRACE_ENTRY]} />);

      expect(screen.getByTestId('trace-entry-step-1')).toBeInTheDocument();
    });

    it('renders all trace entries when multiple are provided', () => {
      const entries: ExecutionTraceEntry[] = [
        { ...TRACE_ENTRY, stepId: 'step-1', label: 'Step One' },
        { ...TRACE_ENTRY, stepId: 'step-2', label: 'Step Two' },
        { ...TRACE_ENTRY, stepId: 'step-3', label: 'Step Three' },
      ];

      render(<ExecutionDetailView execution={makeExecution()} trace={entries} />);

      expect(screen.getByTestId('trace-entry-step-1')).toBeInTheDocument();
      expect(screen.getByTestId('trace-entry-step-2')).toBeInTheDocument();
      expect(screen.getByTestId('trace-entry-step-3')).toBeInTheDocument();
    });

    it('renders the "Step Timeline" section heading', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[]} />);

      expect(screen.getByRole('heading', { name: /step timeline/i })).toBeInTheDocument();
    });

    it('clears filter on timeline click ONLY when the target row is hidden', async () => {
      const user = userEvent.setup();
      const entries: ExecutionTraceEntry[] = [
        { ...TRACE_ENTRY, stepId: 'step-ok', status: 'completed', label: 'OK' },
        { ...TRACE_ENTRY, stepId: 'step-bad', status: 'failed', label: 'Bad' },
      ];

      render(<ExecutionDetailView execution={makeExecution()} trace={entries} />);

      // Apply Failed filter — completed row drops out of the list.
      await user.click(screen.getByTestId('trace-filter-failed'));
      expect(screen.queryByTestId('trace-entry-step-ok')).not.toBeInTheDocument();
      expect(screen.getByTestId('trace-filter-failed')).toHaveAttribute('data-active', 'true');

      // Clicking the OK bar (currently HIDDEN) should reset the filter so the
      // target row appears in the DOM.
      await user.click(screen.getByTestId('timeline-bar-step-ok'));
      expect(screen.getByTestId('trace-entry-step-ok')).toBeInTheDocument();
      expect(screen.getByTestId('trace-filter-all')).toHaveAttribute('data-active', 'true');

      // Re-apply Failed filter, then click the Bad bar (still VISIBLE). The
      // filter must be preserved — we don't drop a deliberate selection
      // when the target is already in the visible set.
      await user.click(screen.getByTestId('trace-filter-failed'));
      expect(screen.getByTestId('trace-filter-failed')).toHaveAttribute('data-active', 'true');
      await user.click(screen.getByTestId('timeline-bar-step-bad'));
      expect(screen.getByTestId('trace-filter-failed')).toHaveAttribute('data-active', 'true');
    });
  });

  describe('Approval prompt card', () => {
    it('shows approval prompt card for paused_for_approval execution with awaiting trace entry', () => {
      const approvalTrace: ExecutionTraceEntry = {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Please review the generated content before publishing.' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T10:00:00.000Z',
        completedAt: '2025-01-01T10:00:00.000Z',
        durationMs: 0,
      };

      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[TRACE_ENTRY, approvalTrace]}
        />
      );

      expect(screen.getByText('Approval prompt')).toBeInTheDocument();
      expect(
        screen.getByText('Please review the generated content before publishing.')
      ).toBeInTheDocument();
    });

    it('does not show prompt card for completed executions', () => {
      const approvalTrace: ExecutionTraceEntry = {
        stepId: 'approval-step',
        stepType: 'human_approval',
        label: 'Review',
        status: 'awaiting_approval',
        output: { prompt: 'Please review the generated content.' },
        tokensUsed: 0,
        costUsd: 0,
        startedAt: '2025-01-01T10:00:00.000Z',
        completedAt: '2025-01-01T10:00:00.000Z',
        durationMs: 0,
      };

      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'completed' })}
          trace={[approvalTrace]}
        />
      );

      expect(screen.queryByText('Approval prompt')).not.toBeInTheDocument();
    });

    it('does not show prompt card when trace has no awaiting_approval entry', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[TRACE_ENTRY]}
        />
      );

      expect(screen.queryByText('Approval prompt')).not.toBeInTheDocument();
    });
  });

  describe('Status badge — cancelled', () => {
    it('renders cancelled status with explicit badge variant', () => {
      render(<ExecutionDetailView execution={makeExecution({ status: 'cancelled' })} trace={[]} />);

      // "Cancelled" now appears in two places: the status badge in the
      // header AND the synopsis panel's headline. getAllByText
      // confirms both are present rather than relying on a duplicate-
      // sensitive single-element matcher.
      const matches = screen.getAllByText('Cancelled');
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('execution-synopsis-cancellation')).toBeInTheDocument();
    });

    it('renders running status badge', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      expect(screen.getByText('Running')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('collapsible JSON card button has aria-expanded', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ inputData: { prompt: 'hello' } })}
          trace={[]}
        />
      );

      const button = screen.getByRole('button', { name: /^input data$/i });
      expect(button).toHaveAttribute('aria-expanded', 'false');

      await user.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('Action buttons', () => {
    it('shows Cancel button when execution is running', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      expect(screen.getByRole('button', { name: /cancel execution/i })).toBeInTheDocument();
    });

    it('shows Approve button when execution is paused_for_approval', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel execution/i })).toBeInTheDocument();
    });

    it('shows Retry button when execution is failed with a failed trace entry', () => {
      const failedTrace: ExecutionTraceEntry = {
        ...TRACE_ENTRY,
        status: 'failed',
        error: 'LLM timeout',
      };

      render(
        <ExecutionDetailView
          execution={makeExecution({
            status: 'failed',
            errorMessage: 'LLM timeout',
          })}
          trace={[failedTrace]}
        />
      );

      expect(screen.getByRole('button', { name: /retry failed step/i })).toBeInTheDocument();
    });

    it('does not show action buttons for completed executions', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[]} />);

      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });

    it('Cancel button calls the cancel endpoint', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel execution/i }));

      expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/cancel'));
    });

    it('Cancel success shows success banner and refreshes', async () => {
      mockPost.mockResolvedValueOnce({ success: true });
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel execution/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Execution cancelled.');
      expect(mockRefresh).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });

    it('Cancel error shows error banner with API error message', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      mockPost.mockRejectedValueOnce(new APIClientError('Execution already completed'));
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel execution/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Execution already completed');
    });

    it('Cancel error shows generic message for non-API errors', async () => {
      mockPost.mockRejectedValueOnce(new Error('Network failure'));
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel execution/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Cancel failed');
    });

    it('Approve button calls the approve endpoint and shows success banner', async () => {
      mockPost.mockResolvedValueOnce({ success: true });
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /approve/i }));

      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/approve'),
        expect.objectContaining({
          body: {},
        })
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(/approved/i);
      expect(mockRefresh).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });

    it('Approve error shows error banner', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      mockPost.mockRejectedValueOnce(new APIClientError('Not in approval state'));
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /approve/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Not in approval state');
    });

    it('Retry button calls the retry-step endpoint with the failed step ID', async () => {
      mockPost.mockResolvedValueOnce({ success: true });
      const user = userEvent.setup();
      const failedTrace: ExecutionTraceEntry = {
        ...TRACE_ENTRY,
        stepId: 'step-fail-1',
        status: 'failed',
        error: 'LLM timeout',
      };
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'failed', errorMessage: 'LLM timeout' })}
          trace={[failedTrace]}
        />
      );

      await user.click(screen.getByRole('button', { name: /retry failed step/i }));

      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/retry-step'),
        expect.objectContaining({
          body: { stepId: 'step-fail-1' },
        })
      );
      // Two alerts: the error banner (errorMessage) + the action success banner
      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.includes('retry'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      expect(mockRefresh).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });

    it('Retry error shows error banner', async () => {
      mockPost.mockRejectedValueOnce(new Error('Server error'));
      const user = userEvent.setup();
      const failedTrace: ExecutionTraceEntry = {
        ...TRACE_ENTRY,
        stepId: 'step-fail-1',
        status: 'failed',
        error: 'LLM timeout',
      };
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'failed', errorMessage: 'LLM timeout' })}
          trace={[failedTrace]}
        />
      );

      await user.click(screen.getByRole('button', { name: /retry failed step/i }));

      // Two alerts: the error banner (errorMessage) + the action error banner
      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.includes('Retry failed'))).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });

    it('buttons are disabled while an action is in progress', async () => {
      // Make post hang until we resolve it
      let resolvePost!: (v: unknown) => void;
      mockPost.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePost = resolve;
          })
      );
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      // Click approve — should disable all action buttons
      await user.click(screen.getByRole('button', { name: /approve/i }));

      const approveBtn = screen.getByRole('button', { name: /approve/i });
      const cancelBtn = screen.getByRole('button', { name: /cancel execution/i });
      expect(approveBtn).toBeDisabled();
      expect(cancelBtn).toBeDisabled();

      // Resolve the pending request
      resolvePost({ success: true });
    });

    it('shows Reject button when execution is paused_for_approval', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
    });

    it('does not show Reject button for completed executions', () => {
      render(<ExecutionDetailView execution={makeExecution()} trace={[]} />);

      expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument();
    });

    it('does not show Reject button for running executions', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[]}
        />
      );

      expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument();
    });

    it('Reject button opens dialog with required reason textarea', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^reject$/i }));

      expect(screen.getByText('Reject execution?')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/does not meet compliance/i)).toBeInTheDocument();
    });

    it('Reject dialog submit button is disabled when reason is empty', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^reject$/i }));

      // The dialog's "Reject" action button should be disabled
      const dialogRejectBtn = screen.getAllByRole('button', { name: /reject/i }).pop()!;
      expect(dialogRejectBtn).toBeDisabled();
    });

    it('Reject dialog submits reason and shows success banner', async () => {
      mockPost.mockResolvedValueOnce({ success: true });
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^reject$/i }));
      await user.type(screen.getByPlaceholderText(/does not meet compliance/i), 'Not compliant');

      // Click the dialog's Reject action button
      const dialogRejectBtn = screen.getAllByRole('button', { name: /reject/i }).pop()!;
      await user.click(dialogRejectBtn);

      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/reject'),
        expect.objectContaining({
          body: { reason: 'Not compliant' },
        })
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('Reject dialog shows error banner on failure', async () => {
      const { APIClientError } = await import('@/lib/api/client');
      mockPost.mockRejectedValueOnce(new APIClientError('Already processed'));
      const user = userEvent.setup();
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval', completedAt: null })}
          trace={[]}
        />
      );

      await user.click(screen.getByRole('button', { name: /^reject$/i }));
      await user.type(screen.getByPlaceholderText(/does not meet compliance/i), 'Not compliant');

      const dialogRejectBtn = screen.getAllByRole('button', { name: /reject/i }).pop()!;
      await user.click(dialogRejectBtn);

      expect(await screen.findByRole('alert')).toHaveTextContent('Already processed');
    });

    it('does not show Retry button for failed execution with no failed trace entry', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'failed', errorMessage: 'Unknown' })}
          trace={[TRACE_ENTRY]}
        />
      );

      // All trace entries are 'completed', so no failedStepId → no retry button
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });
  });

  // ─── Live execution paths ───────────────────────────────────────────────
  // Exercise the synthesised "running" trace entry that the view appends
  // when the live-poll hook returns currentStepDetails. The hook mock at
  // the top of this file passes the seed payload through unchanged, so we
  // shape the props to mirror what the page server-fetches.

  describe('Live execution indicator', () => {
    it('renders the Live pill while the execution is non-terminal', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({
            status: 'running',
            completedAt: null,
            currentStep: 'step-2',
          })}
          trace={[]}
          currentStepDetails={{
            stepId: 'step-2',
            label: 'Analyse data',
            stepType: 'llm_call',
            startedAt: '2025-01-01T10:00:05.000Z',
          }}
        />
      );

      expect(screen.getByTestId('execution-live-pill')).toBeInTheDocument();
      expect(screen.getByTestId('execution-live-pill')).toHaveTextContent(/live/i);
    });

    it('does not render the Live pill once the status is terminal', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'completed' })}
          trace={[TRACE_ENTRY]}
        />
      );

      expect(screen.queryByTestId('execution-live-pill')).not.toBeInTheDocument();
    });

    it('synthesises a running trace row from currentStepDetails', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({
            status: 'running',
            completedAt: null,
            currentStep: 'step-2',
          })}
          trace={[TRACE_ENTRY]}
          currentStepDetails={{
            stepId: 'step-2',
            label: 'Analyse data',
            stepType: 'llm_call',
            startedAt: '2025-01-01T10:00:05.000Z',
          }}
        />
      );

      // The synthesised row gets the standard `trace-entry-${stepId}` test id.
      const synthRow = screen.getByTestId('trace-entry-step-2');
      expect(synthRow).toBeInTheDocument();
      // The visible step label lives inside the synthesised row.
      expect(synthRow).toHaveTextContent('Analyse data');
      // And the original persisted row is still rendered.
      expect(screen.getByTestId('trace-entry-step-1')).toBeInTheDocument();
    });

    it('drops a persisted entry that collides with the running stepId (race guard)', () => {
      // If a step transitions running → completed between server polls, the
      // persisted entry could appear in `trace` at the same time as
      // `currentStepDetails`. The view filters out the persisted dup so
      // there's only ONE row for that stepId — the synthesised running one.
      const persisted = { ...TRACE_ENTRY, stepId: 'step-2', label: 'Persisted (stale)' };
      render(
        <ExecutionDetailView
          execution={makeExecution({
            status: 'running',
            completedAt: null,
            currentStep: 'step-2',
          })}
          trace={[persisted]}
          currentStepDetails={{
            stepId: 'step-2',
            label: 'Analyse data',
            stepType: 'llm_call',
            startedAt: '2025-01-01T10:00:05.000Z',
          }}
        />
      );

      const rows = screen.getAllByTestId('trace-entry-step-2');
      expect(rows).toHaveLength(1);
      // The visible row is the synthesised running one, not the persisted dup.
      expect(screen.queryByText('Persisted (stale)')).not.toBeInTheDocument();
      expect(rows[0]).toHaveTextContent('Analyse data');
    });

    it('does not synthesise a running row when currentStepDetails is null', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'running', completedAt: null })}
          trace={[TRACE_ENTRY]}
          currentStepDetails={null}
        />
      );

      expect(screen.getByTestId('trace-entry-step-1')).toBeInTheDocument();
      // No synthesised entry for any other stepId. Look for any row-level
      // testid (rows are `trace-entry-<stepId>`; children testids carry
      // an extra segment like `trace-entry-step-type-…`). The "step-2"
      // running-row testid must not appear.
      expect(screen.queryByTestId('trace-entry-step-2')).not.toBeInTheDocument();
    });
  });
});
