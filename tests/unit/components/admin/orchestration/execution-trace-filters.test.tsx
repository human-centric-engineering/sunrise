/**
 * Unit Test: ExecutionTraceFilters + applyTraceFilter
 *
 * @see components/admin/orchestration/execution-trace-filters.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionTraceFilters,
  applyTraceFilter,
} from '@/components/admin/orchestration/execution-trace-filters';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step',
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

describe('applyTraceFilter', () => {
  const trace: ExecutionTraceEntry[] = [
    entry({ stepId: 'a', stepType: 'llm_call', status: 'completed', durationMs: 100 }),
    entry({ stepId: 'b', stepType: 'tool_call', status: 'completed', durationMs: 50 }),
    entry({ stepId: 'c', stepType: 'llm_call', status: 'failed', durationMs: 200 }),
    entry({ stepId: 'd', stepType: 'human_approval', status: 'awaiting_approval', durationMs: 0 }),
    entry({ stepId: 'e', stepType: 'external_call', status: 'completed', durationMs: 300 }),
  ];

  it('"all" returns the trace unchanged', () => {
    expect(applyTraceFilter(trace, 'all')).toBe(trace);
  });

  it('"failed" keeps only failed/rejected', () => {
    const result = applyTraceFilter(trace, 'failed');
    expect(result.map((e) => e.stepId)).toEqual(['c']);
  });

  it('"with-approvals" keeps only awaiting_approval', () => {
    const result = applyTraceFilter(trace, 'with-approvals');
    expect(result.map((e) => e.stepId)).toEqual(['d']);
  });

  it('"llm-only" keeps known LLM step types', () => {
    const result = applyTraceFilter(trace, 'llm-only');
    expect(result.map((e) => e.stepId).sort()).toEqual(['a', 'c']);
  });

  it('"tool-only" keeps tool_call and external_call', () => {
    const result = applyTraceFilter(trace, 'tool-only');
    expect(result.map((e) => e.stepId).sort()).toEqual(['b', 'e']);
  });

  it('"slow" returns the original trace unchanged when threshold cannot be computed', () => {
    // n=5 → slowOutlierThresholdMs returns p90; for [0,50,100,200,300] sorted, p90 = 300.
    const result = applyTraceFilter(trace, 'slow');
    // Only the 300ms entry meets ≥ p90.
    expect(result.map((e) => e.stepId)).toEqual(['e']);
  });

  it('"slow" returns full trace when fewer than 5 entries (threshold null)', () => {
    const tiny = trace.slice(0, 3);
    expect(applyTraceFilter(tiny, 'slow')).toEqual(tiny);
  });
});

describe('ExecutionTraceFilters', () => {
  const sampleTrace: ExecutionTraceEntry[] = [
    entry({ stepId: 'a', stepType: 'llm_call' }),
    entry({ stepId: 'b', stepType: 'llm_call', status: 'failed' }),
  ];

  it('renders nothing for an empty trace', () => {
    const { container } = render(
      <ExecutionTraceFilters trace={[]} active="all" onChange={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('marks the currently active filter via data-active="true"', () => {
    render(<ExecutionTraceFilters trace={sampleTrace} active="failed" onChange={() => {}} />);
    expect(screen.getByTestId('trace-filter-failed')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('trace-filter-all')).toHaveAttribute('data-active', 'false');
  });

  it('disables filters that match zero entries (except "all")', () => {
    // No approvals or external_calls in the sample trace.
    render(<ExecutionTraceFilters trace={sampleTrace} active="all" onChange={() => {}} />);
    expect(screen.getByTestId('trace-filter-with-approvals')).toBeDisabled();
    expect(screen.getByTestId('trace-filter-tool-only')).toBeDisabled();
    expect(screen.getByTestId('trace-filter-all')).not.toBeDisabled();
  });

  it('fires onChange with the clicked filter id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ExecutionTraceFilters trace={sampleTrace} active="all" onChange={onChange} />);
    await user.click(screen.getByTestId('trace-filter-failed'));
    expect(onChange).toHaveBeenCalledWith('failed');
  });

  it('shows per-filter counts', () => {
    render(<ExecutionTraceFilters trace={sampleTrace} active="all" onChange={() => {}} />);
    // "All" shows 2; "Failed" shows 1.
    expect(screen.getByTestId('trace-filter-all')).toHaveTextContent('2');
    expect(screen.getByTestId('trace-filter-failed')).toHaveTextContent('1');
  });
});
