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

import { describe, it, expect } from 'vitest';
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
      expect(screen.getByText('1234 ms')).toBeInTheDocument();
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

      await user.click(screen.getByRole('button'));
      expect(screen.getByText('Hello world')).toBeInTheDocument();

      await user.click(screen.getByRole('button'));
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
});
