/**
 * Unit Test: ExecutionTimelineStrip
 *
 * @see components/admin/orchestration/execution-timeline-strip.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExecutionTimelineStrip } from '@/components/admin/orchestration/execution-timeline-strip';
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

describe('ExecutionTimelineStrip', () => {
  it('renders nothing for traces with fewer than 2 entries', () => {
    const { container: emptyContainer } = render(<ExecutionTimelineStrip trace={[]} />);
    expect(emptyContainer.firstChild).toBeNull();

    const { container: singleContainer } = render(<ExecutionTimelineStrip trace={[entry()]} />);
    expect(singleContainer.firstChild).toBeNull();
  });

  it('renders one bar per trace entry', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'a', label: 'Alpha' }),
          entry({ stepId: 'b', label: 'Beta' }),
          entry({ stepId: 'c', label: 'Gamma' }),
        ]}
      />
    );
    expect(screen.getByTestId('timeline-bar-a')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-bar-b')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-bar-c')).toBeInTheDocument();
  });

  it('marks failed bars with data-status="failed"', () => {
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a' }), entry({ stepId: 'b', status: 'failed' })]}
      />
    );
    expect(screen.getByTestId('timeline-bar-a')).toHaveAttribute('data-status', 'completed');
    expect(screen.getByTestId('timeline-bar-b')).toHaveAttribute('data-status', 'failed');
  });

  it('marks slow outliers (≥ p90) with data-slow="true" once trace has at least 5 entries', () => {
    // 10 entries 100..1000 ms. p90 ≈ 900 → only the 1000 ms bar is "slow".
    const trace = Array.from({ length: 10 }, (_, i) =>
      entry({ stepId: `s${i}`, durationMs: (i + 1) * 100 })
    );
    render(<ExecutionTimelineStrip trace={trace} />);

    expect(screen.getByTestId('timeline-bar-s9')).toHaveAttribute('data-slow', 'true');
    expect(screen.getByTestId('timeline-bar-s8')).toHaveAttribute('data-slow', 'true');
    expect(screen.getByTestId('timeline-bar-s0')).toHaveAttribute('data-slow', 'false');
  });

  it('skips slow-outlier highlighting for traces with fewer than 5 entries', () => {
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a', durationMs: 10 }), entry({ stepId: 'b', durationMs: 1000 })]}
      />
    );
    // No threshold should apply — both bars carry data-slow="false".
    expect(screen.getByTestId('timeline-bar-a')).toHaveAttribute('data-slow', 'false');
    expect(screen.getByTestId('timeline-bar-b')).toHaveAttribute('data-slow', 'false');
  });

  it('fires onSelectStep with the bar id on click', async () => {
    const user = userEvent.setup();
    const onSelectStep = vi.fn();
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a' }), entry({ stepId: 'b' })]}
        onSelectStep={onSelectStep}
      />
    );

    await user.click(screen.getByTestId('timeline-bar-b'));

    expect(onSelectStep).toHaveBeenCalledWith('b');
  });

  it('shows the step label and duration in each bar', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'a', label: 'First step', durationMs: 250 }),
          entry({ stepId: 'b', label: 'Second step', durationMs: 750 }),
        ]}
      />
    );
    expect(screen.getByText('First step')).toBeInTheDocument();
    expect(screen.getByText('Second step')).toBeInTheDocument();
    expect(screen.getByText('250 ms')).toBeInTheDocument();
    expect(screen.getByText('750 ms')).toBeInTheDocument();
  });

  // ─── Running-status indicator (live-execution path) ─────────────────────
  // The synthesised running entry has `status: 'running'`, which isn't part
  // of the persisted ExecutionTraceEntry status union. Cast it through
  // `as unknown as` so the test fixture matches what the view actually
  // hands to the strip at runtime.

  it('renders a pulsing primary bar for the running entry', () => {
    const running = entry({
      stepId: 'r1',
      status: 'running' as unknown as ExecutionTraceEntry['status'],
      durationMs: 500,
    });
    render(<ExecutionTimelineStrip trace={[entry({ stepId: 's1', durationMs: 1000 }), running]} />);
    const bar = screen.getByTestId('timeline-bar-r1');
    expect(bar).toHaveAttribute('data-status', 'running');
    // The inner coloured span carries animate-pulse + bg-primary/70.
    const inner = bar.querySelector('span[style]');
    expect(inner?.className).toContain('animate-pulse');
    expect(inner?.className).toContain('bg-primary/70');
  });

  it('falls back to a visible ~25% width when the running step is the only timed one', () => {
    // maxDuration is 0 when all completed siblings have durationMs=0; the
    // running bar still needs to be visible, so it clamps to 25%.
    const running = entry({
      stepId: 'r1',
      status: 'running' as unknown as ExecutionTraceEntry['status'],
      durationMs: 0,
    });
    render(<ExecutionTimelineStrip trace={[entry({ stepId: 's1', durationMs: 0 }), running]} />);
    const bar = screen.getByTestId('timeline-bar-r1');
    const inner = bar.querySelector<HTMLElement>('span[style]');
    expect(inner?.style.width).toBe('25.00%');
  });

  it('includes "Running" in the running bar\'s aria-label', () => {
    const running = entry({
      stepId: 'r1',
      status: 'running' as unknown as ExecutionTraceEntry['status'],
      label: 'Live step',
      durationMs: 100,
    });
    render(<ExecutionTimelineStrip trace={[entry({ stepId: 's1' }), running]} />);
    const bar = screen.getByTestId('timeline-bar-r1');
    expect(bar.getAttribute('aria-label')).toContain('Running');
  });
});
