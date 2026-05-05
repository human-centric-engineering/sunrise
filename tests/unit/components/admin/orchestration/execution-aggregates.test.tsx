/**
 * Unit Test: ExecutionAggregates
 *
 * @see components/admin/orchestration/execution-aggregates.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ExecutionAggregates } from '@/components/admin/orchestration/execution-aggregates';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step 1',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 100,
    ...overrides,
  };
}

describe('ExecutionAggregates', () => {
  it('renders nothing for traces with fewer than 2 entries', () => {
    const { container: empty } = render(<ExecutionAggregates trace={[]} />);
    expect(empty.firstChild).toBeNull();

    const { container: single } = render(<ExecutionAggregates trace={[entry()]} />);
    expect(single.firstChild).toBeNull();
  });

  it('renders the top-level grid for traces with at least 2 entries', () => {
    render(
      <ExecutionAggregates
        trace={[entry({ stepId: 'a', durationMs: 100 }), entry({ stepId: 'b', durationMs: 200 })]}
      />
    );
    expect(screen.getByTestId('execution-aggregates')).toBeInTheDocument();
  });

  it('labels the per-step duration sum as "Step time sum" (not wall-clock)', () => {
    // Sum is 300ms across the two entries — and the label intentionally
    // does NOT say "wall-clock" because parallel branches inflate this.
    render(
      <ExecutionAggregates
        trace={[entry({ stepId: 'a', durationMs: 100 }), entry({ stepId: 'b', durationMs: 200 })]}
      />
    );
    const term = screen.getByText('Step time sum');
    expect(term).toBeInTheDocument();
    expect(term.closest('div')).toHaveTextContent(/300 ms/);
  });

  it('shows the slowest step label and duration', () => {
    render(
      <ExecutionAggregates
        trace={[
          entry({ stepId: 'a', label: 'Quick step', durationMs: 50 }),
          entry({ stepId: 'b', label: 'Slow step', durationMs: 5000 }),
        ]}
      />
    );
    // The slowest-step <dd> carries both the label and the parenthetical
    // duration. Asserting on the parent ensures the binding is correct
    // (a stray "5.00 s" elsewhere in the card wouldn't satisfy this).
    const slowestLabel = screen.getByText('Slow step');
    expect(slowestLabel).toBeInTheDocument();
    expect(slowestLabel.closest('dd')).toHaveTextContent(/5\.00 s/);
  });

  it('groups counts and durations by step type', () => {
    render(
      <ExecutionAggregates
        trace={[
          entry({ stepId: 'a', stepType: 'llm_call', durationMs: 100 }),
          entry({ stepId: 'b', stepType: 'llm_call', durationMs: 200 }),
          entry({ stepId: 'c', stepType: 'tool_call', durationMs: 50 }),
        ]}
      />
    );
    const llmRow = screen.getByTestId('aggregates-step-type-llm_call');
    const toolRow = screen.getByTestId('aggregates-step-type-tool_call');
    expect(llmRow).toHaveTextContent('llm_call');
    expect(llmRow).toHaveTextContent('2');
    expect(llmRow).toHaveTextContent('300 ms');
    expect(toolRow).toHaveTextContent('tool_call');
    expect(toolRow).toHaveTextContent('1');
    expect(toolRow).toHaveTextContent('50 ms');
  });

  it('shows token totals when at least one entry reports inputTokens or outputTokens', () => {
    render(
      <ExecutionAggregates
        trace={[
          entry({ stepId: 'a', inputTokens: 100, outputTokens: 50 }),
          entry({ stepId: 'b', inputTokens: 80, outputTokens: 30 }),
        ]}
      />
    );
    expect(screen.getByText(/180 in/)).toBeInTheDocument();
    expect(screen.getByText(/80 out/)).toBeInTheDocument();
  });

  it('omits the LLM share line when no llmDurationMs is recorded', () => {
    render(
      <ExecutionAggregates
        trace={[entry({ stepId: 'a', durationMs: 100 }), entry({ stepId: 'b', durationMs: 200 })]}
      />
    );
    // The label exists, but the value should be the em-dash placeholder.
    expect(screen.getByText('LLM share')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders LLM-share percentage when llmDurationMs is present', () => {
    render(
      <ExecutionAggregates
        trace={[
          entry({ stepId: 'a', durationMs: 100, llmDurationMs: 80 }),
          entry({ stepId: 'b', durationMs: 100, llmDurationMs: 60 }),
        ]}
      />
    );
    // 140ms / 200ms = 70%.
    expect(screen.getByText(/70%/)).toBeInTheDocument();
  });
});
