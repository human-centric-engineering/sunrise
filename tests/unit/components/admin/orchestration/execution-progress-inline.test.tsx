/**
 * Unit Test: ExecutionProgressInline
 *
 * @see components/admin/orchestration/execution-progress-inline.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionProgressInline } from '@/components/admin/orchestration/execution-progress-inline';
import type {
  ExecutionLivePayload,
  ExecutionLiveSnapshot,
} from '@/lib/hooks/use-execution-live-poll';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPost = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
    get: vi.fn().mockResolvedValue({}),
  },
  APIClientError: class extends Error {},
}));

// Pass the initial payload straight through — polling behaviour is
// covered by the live-poll hook's own tests; the component is exercised
// against a static snapshot so the assertions stay deterministic.
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

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';

function snapshot(overrides: Partial<ExecutionLiveSnapshot> = {}): ExecutionLiveSnapshot {
  return {
    id: EXEC_ID,
    status: 'running',
    currentStep: 'step-1',
    errorMessage: null,
    totalTokensUsed: 0,
    totalCostUsd: 0,
    startedAt: '2026-05-15T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

function payload(over: Partial<ExecutionLivePayload> = {}): ExecutionLivePayload {
  return {
    snapshot: snapshot(),
    trace: [],
    costEntries: [],
    currentStepDetails: null,
    ...over,
  };
}

function awaitingApprovalTrace(prompt = 'Review the proposed changes.'): ExecutionTraceEntry[] {
  // Two entries so the timeline strip's `< 2` early-return isn't taken
  // (keeps the test surface representative of a real paused run).
  return [
    {
      stepId: 'step-prep',
      stepType: 'llm_call',
      label: 'Prepare audit',
      status: 'completed',
      output: 'done',
      tokensUsed: 100,
      costUsd: 0.001,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:01.000Z',
      durationMs: 1_000,
    },
    {
      stepId: 'step-review',
      stepType: 'human_approval',
      label: 'Review',
      status: 'awaiting_approval',
      output: { prompt },
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2026-05-15T10:00:01.000Z',
      completedAt: '2026-05-15T10:00:01.000Z',
      durationMs: 0,
    },
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutionProgressInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('status row', () => {
    it('renders the formatted status badge from the seeded snapshot', () => {
      render(<ExecutionProgressInline executionId={EXEC_ID} initialPayload={payload()} />);
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('renders the current step label when present and non-terminal', () => {
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            currentStepDetails: {
              stepId: 'step-1',
              label: 'Searching the web',
              stepType: 'external_call',
              startedAt: '2026-05-15T10:00:00.000Z',
            },
          })}
        />
      );
      expect(screen.getByText('Searching the web')).toBeInTheDocument();
    });

    it('renders tokens and cost when non-zero', () => {
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ totalTokensUsed: 12_345, totalCostUsd: 0.0521 }),
          })}
        />
      );
      expect(screen.getByText(/12,345 tokens/)).toBeInTheDocument();
      expect(screen.getByText(/\$0\.0521/)).toBeInTheDocument();
    });

    it('shows the failure error message when terminal-failed', () => {
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'failed', errorMessage: 'Budget exceeded' }),
          })}
        />
      );
      expect(screen.getByRole('alert')).toHaveTextContent('Budget exceeded');
    });
  });

  describe('approval card', () => {
    it('hides the approval card while the run is still running', () => {
      render(<ExecutionProgressInline executionId={EXEC_ID} initialPayload={payload()} />);
      expect(screen.queryByTestId('execution-progress-inline-approval')).toBeNull();
    });

    it('shows the approval card when status is paused_for_approval', () => {
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'paused_for_approval' }),
            trace: awaitingApprovalTrace(),
          })}
        />
      );
      const card = screen.getByTestId('execution-progress-inline-approval');
      expect(card).toBeInTheDocument();
      expect(card).toHaveTextContent('Approval required');
    });

    it('renders the approval prompt as markdown', () => {
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'paused_for_approval' }),
            trace: awaitingApprovalTrace('## Review changes\n\n- Item A\n- Item B'),
          })}
        />
      );
      // Heading + list items survive the markdown pass — confirms the
      // MarkdownContent renderer is wired, not plain text.
      expect(screen.getByRole('heading', { name: 'Review changes' })).toBeInTheDocument();
      expect(screen.getByText('Item A')).toBeInTheDocument();
      expect(screen.getByText('Item B')).toBeInTheDocument();
    });

    it('sends notes to the admin approve endpoint when Approve → Confirm is clicked', async () => {
      const user = userEvent.setup();
      const onApproved = vi.fn();
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'paused_for_approval' }),
            trace: awaitingApprovalTrace(),
          })}
          onApproved={onApproved}
        />
      );

      await user.click(screen.getByRole('button', { name: /^Approve$/ }));
      const notes = screen.getByLabelText(/Notes \(optional\)/);
      await user.type(notes, 'Looks good');
      await user.click(screen.getByRole('button', { name: /Confirm approval/ }));

      expect(mockPost).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/executions/${EXEC_ID}/approve`,
        { body: { notes: 'Looks good' } }
      );
      expect(onApproved).toHaveBeenCalled();
    });

    it('refuses to submit a reject without a reason and surfaces the validation error', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'paused_for_approval' }),
            trace: awaitingApprovalTrace(),
          })}
        />
      );

      await user.click(screen.getByRole('button', { name: /^Reject$/ }));
      await user.click(screen.getByRole('button', { name: /Confirm rejection/ }));

      expect(mockPost).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('reason is required');
    });

    it('sends reason to the admin reject endpoint when Reject → Confirm is clicked', async () => {
      const user = userEvent.setup();
      const onRejected = vi.fn();
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'paused_for_approval' }),
            trace: awaitingApprovalTrace(),
          })}
          onRejected={onRejected}
        />
      );

      await user.click(screen.getByRole('button', { name: /^Reject$/ }));
      const reasonInput = screen.getByLabelText(/Reason \(required\)/);
      await user.type(reasonInput, 'Bad proposal');
      await user.click(screen.getByRole('button', { name: /Confirm rejection/ }));

      expect(mockPost).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/executions/${EXEC_ID}/reject`,
        { body: { reason: 'Bad proposal' } }
      );
      expect(onRejected).toHaveBeenCalled();
    });
  });

  describe('onTerminal callback', () => {
    it('fires onTerminal exactly once when the seed snapshot is already terminal', async () => {
      const onTerminal = vi.fn();
      render(
        <ExecutionProgressInline
          executionId={EXEC_ID}
          initialPayload={payload({
            snapshot: snapshot({ status: 'completed', completedAt: '2026-05-15T10:01:00.000Z' }),
          })}
          onTerminal={onTerminal}
        />
      );
      // queueMicrotask defers one tick — wait for it.
      await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
      expect(onTerminal).toHaveBeenCalledWith('completed');
    });
  });

  describe('detail-page escape hatch', () => {
    it('renders a "View full details" link pointing at the execution detail page', () => {
      render(<ExecutionProgressInline executionId={EXEC_ID} initialPayload={payload()} />);
      const link = screen.getByRole('link', { name: /View full details/ });
      expect(link).toHaveAttribute('href', `/admin/orchestration/executions/${EXEC_ID}`);
    });
  });
});
