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
  apiClient: { post: (...args: unknown[]) => mockPost(...args) },
  APIClientError: class extends Error {},
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

    it('formats underscored status as title-case words', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ status: 'paused_for_approval' })}
          trace={[]}
        />
      );

      expect(screen.getByText('Paused For Approval')).toBeInTheDocument();
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

  describe('Error banner', () => {
    it('renders error banner when errorMessage is present', () => {
      render(
        <ExecutionDetailView
          execution={makeExecution({ errorMessage: 'Step 3 timed out' })}
          trace={[]}
        />
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Step 3 timed out')).toBeInTheDocument();
    });

    it('does not render error banner when errorMessage is null', () => {
      render(<ExecutionDetailView execution={makeExecution({ errorMessage: null })} trace={[]} />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

      const inputButton = screen.getByRole('button', { name: /input data/i });
      expect(inputButton).toBeInTheDocument();

      // Click to expand
      await user.click(inputButton);
      expect(screen.getByText(/"prompt"/)).toBeInTheDocument();
    });

    it('does not render Input Data card when inputData is null', () => {
      render(<ExecutionDetailView execution={makeExecution({ inputData: null })} trace={[]} />);

      expect(screen.queryByRole('button', { name: /input data/i })).not.toBeInTheDocument();
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
  });

  describe('Status badge — cancelled', () => {
    it('renders cancelled status with explicit badge variant', () => {
      render(<ExecutionDetailView execution={makeExecution({ status: 'cancelled' })} trace={[]} />);

      expect(screen.getByText('Cancelled')).toBeInTheDocument();
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

      const button = screen.getByRole('button', { name: /input data/i });
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
  });
});
