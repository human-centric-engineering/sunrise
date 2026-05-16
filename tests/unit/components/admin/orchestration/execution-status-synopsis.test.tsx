/**
 * Tests for `ExecutionStatusSynopsis` component.
 *
 * Covers the three rendered variants (failure / cancellation /
 * skips_only) and the no-render happy path. Default-expand behaviour
 * (failure auto-open; cancellation/skips collapsed) is asserted
 * explicitly because that's the UX contract the synopsis exists to
 * deliver. Action wiring (jump-to-step, retry, copy-reason) is verified
 * via the callbacks.
 *
 * @see components/admin/orchestration/execution-status-synopsis.tsx
 * @see lib/orchestration/trace/synopsis.ts (the pure analyzer this
 *      component composes — helper-level tests live alongside it)
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ExecutionStatusSynopsis } from '@/components/admin/orchestration/execution-status-synopsis';
import type { ExecutionTraceEntry } from '@/types/orchestration';
import type { SynopsisExecution } from '@/lib/orchestration/trace/synopsis';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 'step',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: { ok: true },
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-16T10:00:00.000Z',
    durationMs: 10,
    ...overrides,
  };
}

const RUN_COMPLETED: SynopsisExecution = {
  status: 'completed',
  errorMessage: null,
  currentStep: null,
};

// ─── No-render happy path ──────────────────────────────────────────────────

describe('ExecutionStatusSynopsis — no render', () => {
  it('renders nothing for a clean completion', () => {
    const { container } = render(
      <ExecutionStatusSynopsis execution={RUN_COMPLETED} trace={[entry({ stepId: 'a' })]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when completion includes only expected skips', () => {
    const trace = [
      entry({ stepId: 'a' }),
      entry({ stepId: 'b', status: 'skipped', expectedSkip: true, error: 'optional skipped' }),
    ];
    const { container } = render(
      <ExecutionStatusSynopsis execution={RUN_COMPLETED} trace={trace} />
    );
    expect(container.firstChild).toBeNull();
  });
});

// ─── Failure variant ───────────────────────────────────────────────────────

describe('ExecutionStatusSynopsis — failure variant', () => {
  function failedRun(): { execution: SynopsisExecution; trace: ExecutionTraceEntry[] } {
    return {
      execution: {
        status: 'failed',
        errorMessage: 'Connection refused',
        currentStep: 'b',
      },
      trace: [
        entry({ stepId: 'a', label: 'Load data', output: { value: 42 } }),
        entry({
          stepId: 'b',
          label: 'Call API',
          stepType: 'external_call',
          status: 'failed',
          error: 'Connection refused',
        }),
      ],
    };
  }

  it('renders the failure panel with the headline step label', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    expect(screen.getByTestId('execution-synopsis-failure')).toBeInTheDocument();
    expect(screen.getByText(/Failed at "Call API"/i)).toBeInTheDocument();
  });

  it('renders the step-type chip alongside the headline', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);
    expect(screen.getByText('external_call')).toBeInTheDocument();
  });

  it('renders the reason in a copyable block (default-expanded)', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    const reason = screen.getByTestId('execution-synopsis-reason');
    expect(reason.textContent).toBe('Connection refused');
  });

  it('renders the predecessor "what this step was looking at" toggle', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    const toggle = screen.getByTestId('execution-synopsis-context-toggle');
    expect(toggle.textContent).toMatch(/Load data/);
  });

  it('expands the predecessor context on click and shows the prior output', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-context-toggle'));
    const context = screen.getByTestId('execution-synopsis-context');
    // The JsonPretty renders the object's keys + values somewhere
    // inside; assert the value appears in the text.
    expect(context.textContent).toMatch(/42/);
  });

  it('collapses to a 1-line reason summary when the Hide toggle is clicked', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    // Click Hide.
    fireEvent.click(screen.getByTestId('execution-synopsis-toggle'));

    // Reason block hidden; collapsed summary shows the first line.
    expect(screen.queryByTestId('execution-synopsis-reason')).not.toBeInTheDocument();
    expect(screen.getByTestId('execution-synopsis-collapsed-reason').textContent).toBe(
      'Connection refused'
    );
  });

  it('shows the cause-chain row when terminalAuthor exists (failWorkflow path)', () => {
    // Replicates the audit-template fix: validate_proposals exhausts
    // retries → workflow finalised via report_validation_failure (a
    // send_notification with terminalStatus: 'failed'). Synopsis must
    // spotlight the culprit AND name the messenger.
    const execution: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'capabilities not in spec',
      currentStep: 'report_validation_failure',
    };
    const trace: ExecutionTraceEntry[] = [
      entry({ stepId: 'audit', label: 'Run audit', output: { models: [] } }),
      entry({
        stepId: 'validate_proposals',
        label: 'Validate proposals',
        stepType: 'guard',
        retries: [
          {
            attempt: 3,
            maxRetries: 2,
            reason: 'capabilities not in spec',
            targetStepId: 'report_validation_failure',
            exhausted: true,
          },
        ],
      }),
      entry({
        stepId: 'report_validation_failure',
        label: 'Notify admin: validation exhausted',
        stepType: 'send_notification',
      }),
    ];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    expect(
      screen.getByText(/Failed: retries exhausted at "Validate proposals"/)
    ).toBeInTheDocument();
    const chain = screen.getByTestId('execution-synopsis-cause-chain');
    expect(chain.textContent).toMatch(/Validate proposals/);
    expect(chain.textContent).toMatch(/Notify admin: validation exhausted/);
  });

  it('renders the retry timeline including the exhaustion event', () => {
    const execution: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'reason',
      currentStep: 'fail-handler',
    };
    const trace: ExecutionTraceEntry[] = [
      entry({
        stepId: 'guard',
        label: 'Validate',
        retries: [
          { attempt: 1, maxRetries: 2, reason: 'first fail', targetStepId: 'producer' },
          { attempt: 2, maxRetries: 2, reason: 'second fail', targetStepId: 'producer' },
          {
            attempt: 3,
            maxRetries: 2,
            reason: 'final fail',
            targetStepId: 'fail-handler',
            exhausted: true,
          },
        ],
      }),
      entry({ stepId: 'fail-handler', label: 'Handler' }),
    ];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    const retries = screen.getByTestId('execution-synopsis-retries');
    expect(retries.textContent).toMatch(/Retry budget exhausted/);
    expect(retries.textContent).toMatch(/first fail/);
    expect(retries.textContent).toMatch(/second fail/);
    expect(retries.textContent).toMatch(/final fail/);
  });

  it('wires "Jump to step" to onJumpToStep with the headline stepId', () => {
    const { execution, trace } = failedRun();
    const onJumpToStep = vi.fn();
    render(
      <ExecutionStatusSynopsis execution={execution} trace={trace} onJumpToStep={onJumpToStep} />
    );

    fireEvent.click(screen.getByTestId('execution-synopsis-jump'));
    expect(onJumpToStep).toHaveBeenCalledWith('b');
  });

  it('wires "Retry from this step" to onRetry with the headline stepId', () => {
    const { execution, trace } = failedRun();
    const onRetry = vi.fn();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-retry'));
    expect(onRetry).toHaveBeenCalledWith('b');
  });

  it('omits the action buttons when callbacks are not supplied', () => {
    const { execution, trace } = failedRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    expect(screen.queryByTestId('execution-synopsis-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('execution-synopsis-retry')).not.toBeInTheDocument();
  });

  it('renders the unexpected-skip tally line when present alongside a failure', () => {
    // A failed run can have skips mixed in. We surface the count so
    // the operator knows there's secondary signal worth reviewing in
    // the timeline below.
    const execution: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'whoops',
      currentStep: 'b',
    };
    const trace: ExecutionTraceEntry[] = [
      entry({ stepId: 'a' }),
      entry({ stepId: 'notif', status: 'skipped', error: 'SMTP down' }),
      entry({ stepId: 'b', status: 'failed', error: 'whoops' }),
    ];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);
    expect(screen.getByText(/1 unexpected skip/)).toBeInTheDocument();
  });

  it('does not render skip tally when only expected skips accompany a failure', () => {
    const execution: SynopsisExecution = {
      status: 'failed',
      errorMessage: 'whoops',
      currentStep: 'b',
    };
    const trace: ExecutionTraceEntry[] = [
      entry({ stepId: 'a' }),
      entry({ stepId: 'opt', status: 'skipped', expectedSkip: true }),
      entry({ stepId: 'b', status: 'failed', error: 'whoops' }),
    ];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);
    expect(screen.queryByText(/unexpected skip/)).not.toBeInTheDocument();
  });
});

// ─── Cancellation variant ──────────────────────────────────────────────────

describe('ExecutionStatusSynopsis — cancellation variant', () => {
  it('renders the cancellation panel collapsed by default', () => {
    const execution: SynopsisExecution = {
      status: 'cancelled',
      errorMessage: 'Rejected: payload was off',
      currentStep: 'review',
    };
    const trace = [entry({ stepId: 'review', label: 'Review changes' })];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    const panel = screen.getByTestId('execution-synopsis-cancellation');
    expect(within(panel).getByText('Cancelled')).toBeInTheDocument();
    // Collapsed by default — no Reason block visible yet.
    expect(screen.queryByTestId('execution-synopsis-reason')).not.toBeInTheDocument();
  });

  it('expands the cancellation panel on click and surfaces the reason + step', () => {
    const execution: SynopsisExecution = {
      status: 'cancelled',
      errorMessage: 'Rejected: payload was off',
      currentStep: 'review',
    };
    const trace = [entry({ stepId: 'review', label: 'Review changes' })];

    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-toggle'));
    expect(screen.getByTestId('execution-synopsis-reason').textContent).toBe(
      'Rejected: payload was off'
    );
    expect(screen.getByText(/Review changes/)).toBeInTheDocument();
  });
});

// ─── Skips-only variant ────────────────────────────────────────────────────

describe('ExecutionStatusSynopsis — skips_only variant', () => {
  function skipsRun(): { execution: SynopsisExecution; trace: ExecutionTraceEntry[] } {
    return {
      execution: RUN_COMPLETED,
      trace: [
        entry({ stepId: 'a' }),
        entry({
          stepId: 'notif',
          label: 'Send admin notification',
          status: 'skipped',
          error: 'SMTP unreachable',
        }),
        entry({
          stepId: 'opt',
          label: 'Optional enrichment',
          status: 'skipped',
          expectedSkip: true,
          error: 'no api key',
        }),
      ],
    };
  }

  it('renders the skip panel with summary line, collapsed by default', () => {
    const { execution, trace } = skipsRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    const panel = screen.getByTestId('execution-synopsis-skips');
    expect(within(panel).getByText(/Completed with skipped steps/)).toBeInTheDocument();
    expect(within(panel).getByText(/1 unexpected skip \(1 expected\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('execution-synopsis-skip-list')).not.toBeInTheDocument();
  });

  it('expands to a list with both expected and unexpected rows', () => {
    const { execution, trace } = skipsRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-toggle'));

    const list = screen.getByTestId('execution-synopsis-skip-list');
    expect(within(list).getByTestId('execution-synopsis-skip-notif')).toBeInTheDocument();
    expect(within(list).getByTestId('execution-synopsis-skip-opt')).toBeInTheDocument();

    // The unexpected one renders an "unexpected" badge, the expected
    // one renders an "expected" badge.
    expect(within(list).getByText('unexpected')).toBeInTheDocument();
    expect(within(list).getByText('expected')).toBeInTheDocument();
  });

  it('renders skip reasons inline when present', () => {
    const { execution, trace } = skipsRun();
    render(<ExecutionStatusSynopsis execution={execution} trace={trace} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-toggle'));
    expect(screen.getByText('SMTP unreachable')).toBeInTheDocument();
    expect(screen.getByText('no api key')).toBeInTheDocument();
  });

  it('falls back to "no reason captured" when a skipped step has no error', () => {
    const trace = [
      entry({ stepId: 'a' }),
      entry({ stepId: 'unknown', label: 'Mystery skip', status: 'skipped' }),
    ];
    render(<ExecutionStatusSynopsis execution={RUN_COMPLETED} trace={trace} />);

    fireEvent.click(screen.getByTestId('execution-synopsis-toggle'));
    expect(screen.getByText(/no reason captured/i)).toBeInTheDocument();
  });

  it('formats the summary without "(N expected)" when there are no expected skips', () => {
    const trace = [
      entry({ stepId: 'a' }),
      entry({ stepId: 'b', status: 'skipped', error: 'real error' }),
    ];
    render(<ExecutionStatusSynopsis execution={RUN_COMPLETED} trace={trace} />);

    const panel = screen.getByTestId('execution-synopsis-skips');
    // "1 unexpected skip" with no parenthetical.
    expect(within(panel).getByText('1 unexpected skip')).toBeInTheDocument();
  });
});
