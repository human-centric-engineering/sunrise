/**
 * Unit Tests: ExecutionTraceEntryRow
 *
 * Test Coverage:
 * - Collapsed render: shows label, stepType, status text
 * - Expand/collapse toggle on click
 * - Error display when expanded
 * - String output renders directly
 * - Object output renders as JSON.stringify
 * - Duration, tokens, cost display
 * - Running status shows animated spinner class
 *
 * @see components/admin/orchestration/workflow-builder/execution-trace-entry.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionTraceEntryRow } from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';
import type { ExecutionTraceEntryRowProps } from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_PROPS: ExecutionTraceEntryRowProps = {
  stepId: 'step-1',
  stepType: 'llm_call',
  label: 'Generate Summary',
  status: 'completed',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionTraceEntryRow', () => {
  describe('collapsed render', () => {
    it('renders label and step type', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} />);
      expect(screen.getByText('Generate Summary')).toBeInTheDocument();
      expect(screen.getByText('llm_call')).toBeInTheDocument();
    });

    it('renders status text', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} status="completed" />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('renders data-testid with stepId', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} />);
      expect(screen.getByTestId('trace-entry-step-1')).toBeInTheDocument();
    });

    it('does not show output when collapsed', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="some output" />);
      expect(screen.queryByText('some output')).not.toBeInTheDocument();
    });

    it('shows duration when provided', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} durationMs={1234} />);
      // toLocaleString() formats with thousands separators in en-US.
      expect(screen.getByText(/1,?234 ms/)).toBeInTheDocument();
    });

    it('shows token count when > 0', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} tokensUsed={500} />);
      expect(screen.getByText('500 tokens')).toBeInTheDocument();
    });

    it('shows cost when > 0', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} costUsd={0.0042} />);
      expect(screen.getByText('$0.0042')).toBeInTheDocument();
    });
  });

  describe('expand/collapse toggle', () => {
    it('expands on click to show output', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="Hello world" />);

      expect(screen.queryByText('Hello world')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button'));

      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('collapses on second click', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="Hello world" />);

      // The expand toggle is the first button in the row. When expanded,
      // additional buttons (e.g. JsonPane Copy) appear, so target the
      // expand toggle by index instead of `getByRole`.
      await user.click(screen.getAllByRole('button')[0]);
      expect(screen.getByText('Hello world')).toBeInTheDocument();

      await user.click(screen.getAllByRole('button')[0]);
      expect(screen.queryByText('Hello world')).not.toBeInTheDocument();
    });
  });

  describe('expanded: error display', () => {
    it('renders error in a pre block when expanded', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionTraceEntryRow {...BASE_PROPS} status="failed" error="Something went wrong" />
      );

      await user.click(screen.getByRole('button'));

      const errorEl = screen.getByText('Something went wrong');
      expect(errorEl).toBeInTheDocument();
      expect(errorEl.tagName).toBe('PRE');
    });

    it('does not render error block when no error is provided', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="data" />);

      await user.click(screen.getByRole('button'));

      // Only the output pre should exist, not an error pre
      const pres = screen.getAllByText((_, el) => el?.tagName === 'PRE');
      expect(pres).toHaveLength(1);
      expect(pres[0].textContent).toBe('data');
    });
  });

  describe('expanded: output serialisation', () => {
    it('renders string output directly', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="plain text output" />);

      await user.click(screen.getByRole('button'));

      expect(screen.getByText('plain text output')).toBeInTheDocument();
    });

    it('renders object output as formatted JSON', async () => {
      const user = userEvent.setup();
      const obj = { result: 'success', count: 42 };
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output={obj} />);

      await user.click(screen.getByRole('button'));

      // The pre element contains the formatted JSON
      const pres = screen.getAllByText((_, el) => el?.tagName === 'PRE');
      const outputPre = pres.find((el) => el.textContent?.includes('"result"'));
      expect(outputPre).toBeDefined();
      expect(outputPre?.textContent).toContain('"count": 42');
    });

    it('does not render output section when output is undefined', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} />);

      await user.click(screen.getByRole('button'));

      // The expanded section exists (border-t) but has no pre elements
      expect(screen.queryAllByText((_, el) => el?.tagName === 'PRE')).toHaveLength(0);
    });
  });

  describe('status variants', () => {
    it('renders "Running" for running status', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} status="running" />);
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('renders "Failed" for failed status', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} status="failed" />);
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('renders "Awaiting approval" for awaiting_approval status', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} status="awaiting_approval" />);
      expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    });
  });

  describe('retry button', () => {
    it('shows retry button for failed step when onRetry is provided', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          status="failed"
          error="LLM timeout"
          onRetry={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button'));
      expect(screen.getByRole('button', { name: /retry from this step/i })).toBeInTheDocument();
    });

    it('calls onRetry with stepId when retry button is clicked', async () => {
      const onRetry = vi.fn();
      const user = userEvent.setup();
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          status="failed"
          error="LLM timeout"
          onRetry={onRetry}
        />
      );

      await user.click(screen.getByRole('button'));
      await user.click(screen.getByRole('button', { name: /retry from this step/i }));

      expect(onRetry).toHaveBeenCalledWith('step-1');
    });

    it('does not show retry button for non-failed steps', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} status="completed" onRetry={vi.fn()} />);

      await user.click(screen.getByRole('button'));
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 4 — new latency / model / cost-entry surfaces.
  // ────────────────────────────────────────────────────────────────────────

  describe('model / provider chip', () => {
    it('renders provider · model when both are present', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} model="gpt-4o-mini" provider="openai" />);
      expect(screen.getByTestId('trace-entry-model-step-1')).toHaveTextContent(
        'openai · gpt-4o-mini'
      );
    });

    it('renders model alone when no provider', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} model="gpt-4o-mini" />);
      expect(screen.getByTestId('trace-entry-model-step-1')).toHaveTextContent('gpt-4o-mini');
    });

    it('does not render the chip when no model', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} />);
      expect(screen.queryByTestId('trace-entry-model-step-1')).toBeNull();
    });
  });

  describe('latency breakdown', () => {
    it('shows "LLM xxx ms · other yyy ms" when both fields are present', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} durationMs={500} llmDurationMs={350} />);
      const breakdown = screen.getByTestId('trace-entry-latency-breakdown-step-1');
      expect(breakdown).toHaveTextContent('LLM 350 ms');
      expect(breakdown).toHaveTextContent('other 150 ms');
    });

    it('omits the breakdown when llmDurationMs is missing', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} durationMs={500} />);
      expect(screen.queryByTestId('trace-entry-latency-breakdown-step-1')).toBeNull();
    });

    it('omits the breakdown when llmDurationMs is zero (non-LLM step)', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} durationMs={500} llmDurationMs={0} />);
      expect(screen.queryByTestId('trace-entry-latency-breakdown-step-1')).toBeNull();
    });
  });

  describe('input / output side-by-side', () => {
    it('renders both input and output when expanded', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          input={{ prompt: 'Hi there' }}
          output={{ reply: 'Hello' }}
        />
      );
      await user.click(screen.getByRole('button'));
      expect(screen.getByTestId('trace-entry-input-step-1')).toHaveTextContent('Hi there');
      expect(screen.getByTestId('trace-entry-output-step-1')).toHaveTextContent('Hello');
    });

    it('renders input alone when output is undefined', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} input={{ prompt: 'just input' }} />);
      await user.click(screen.getByRole('button'));
      expect(screen.getByTestId('trace-entry-input-step-1')).toHaveTextContent('just input');
      expect(screen.queryByTestId('trace-entry-output-step-1')).toBeNull();
    });
  });

  describe('per-call cost sub-table', () => {
    it('renders a row per cost entry when expanded', async () => {
      const user = userEvent.setup();
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          costEntries={[
            {
              model: 'gpt-4o-mini',
              provider: 'openai',
              inputTokens: 100,
              outputTokens: 50,
              totalCostUsd: 0.005,
              operation: 'chat',
              createdAt: '2026-01-01T00:00:00Z',
            },
            {
              model: 'gpt-4o-mini',
              provider: 'openai',
              inputTokens: 80,
              outputTokens: 30,
              totalCostUsd: 0.004,
              operation: 'chat',
              createdAt: '2026-01-01T00:00:01Z',
            },
          ]}
        />
      );
      await user.click(screen.getByRole('button'));
      const sub = screen.getByTestId('trace-entry-cost-entries-step-1');
      // One header row + two body rows.
      expect(sub.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(sub).toHaveTextContent('Per-call cost (2)');
      expect(sub).toHaveTextContent('$0.0050');
      expect(sub).toHaveTextContent('$0.0040');
    });

    it('does not render the sub-table when no cost entries', async () => {
      const user = userEvent.setup();
      render(<ExecutionTraceEntryRow {...BASE_PROPS} output="x" />);
      await user.click(screen.getByRole('button'));
      expect(screen.queryByTestId('trace-entry-cost-entries-step-1')).toBeNull();
    });
  });

  describe('highlight prop', () => {
    it('applies the highlight ring class when highlighted=true', () => {
      const { container } = render(<ExecutionTraceEntryRow {...BASE_PROPS} highlighted />);
      const root = container.querySelector('[data-testid="trace-entry-step-1"]');
      expect(root?.className).toMatch(/ring-/);
    });

    it('does not apply the ring class when highlighted is false', () => {
      const { container } = render(<ExecutionTraceEntryRow {...BASE_PROPS} />);
      const root = container.querySelector('[data-testid="trace-entry-step-1"]');
      expect(root?.className ?? '').not.toMatch(/ring-/);
    });
  });

  describe('retries sub-rows', () => {
    it('renders an attempt sub-row for each non-exhausted retry', () => {
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          retries={[
            {
              attempt: 1,
              maxRetries: 2,
              reason: 'tierRole "supercomputer" is not valid',
              targetStepId: 'audit_models',
            },
          ]}
        />
      );
      expect(
        screen.getByText('Attempt 1 of 2 failed — re-running audit_models')
      ).toBeInTheDocument();
      expect(screen.getByText(/Reason: tierRole "supercomputer" is not valid/)).toBeInTheDocument();
    });

    it('renders an exhaustion sub-row when exhausted is true', () => {
      render(
        <ExecutionTraceEntryRow
          {...BASE_PROPS}
          retries={[
            {
              attempt: 3,
              maxRetries: 2,
              reason: 'final failure',
              targetStepId: 'report_validation_failure',
              exhausted: true,
            },
          ]}
        />
      );
      expect(
        screen.getByText('Retry budget exhausted — routed to report_validation_failure')
      ).toBeInTheDocument();
    });

    it('does not render a retries list when no retries are provided', () => {
      render(<ExecutionTraceEntryRow {...BASE_PROPS} />);
      expect(screen.queryByTestId('trace-entry-retries-step-1')).not.toBeInTheDocument();
    });
  });
});
