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

  it('keeps very-short bars visible by flooring width to 0.5% in Gantt mode', () => {
    // A zero-duration running step starting at execStart should still
    // render a hairline bar at left=0 — falls under the min-width floor.
    const running = entry({
      stepId: 'r1',
      status: 'running' as unknown as ExecutionTraceEntry['status'],
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: undefined,
      durationMs: 0,
    });
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 's1', durationMs: 1000 }), // contributes a non-zero totalSpan
          running,
        ]}
      />
    );
    const inner = screen.getByTestId('timeline-bar-fill-r1');
    expect(parseFloat(inner.style.width)).toBeGreaterThan(0);
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

  // ─── Remaining colour / branch coverage ────────────────────────────────

  it('marks skipped entries with data-status="skipped" and the muted bar colour', () => {
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a' }), entry({ stepId: 'b', status: 'skipped' })]}
      />
    );
    const bar = screen.getByTestId('timeline-bar-b');
    expect(bar).toHaveAttribute('data-status', 'skipped');
    const inner = bar.querySelector('span[style]');
    expect(inner?.className).toContain('bg-muted-foreground/40');
  });

  it('toggles duration unit from ms to s when the segmented control is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a', durationMs: 1234 }), entry({ stepId: 'b', durationMs: 250 })]}
      />
    );

    // Default unit is ms.
    expect(screen.getByText('1,234 ms')).toBeInTheDocument();

    // Click the "s" button in the unit toggle.
    await user.click(screen.getByTestId('timeline-unit-s'));

    // Now both rows render in seconds with 2 decimals.
    expect(screen.getByText('1.23 s')).toBeInTheDocument();
    expect(screen.getByText('0.25 s')).toBeInTheDocument();
  });

  // ─── Gantt positioning (shared wall-clock axis) ─────────────────────────

  it('positions bars on a shared wall-clock axis (left offset reflects startedAt)', () => {
    // 10-second execution: s1 at 0–4s, s2 at 4–10s.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:04.000Z',
            durationMs: 4_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:04.000Z',
            completedAt: '2026-01-01T00:00:10.000Z',
            durationMs: 6_000,
          }),
        ]}
      />
    );

    const s1 = screen.getByTestId('timeline-bar-fill-s1');
    const s2 = screen.getByTestId('timeline-bar-fill-s2');

    expect(parseFloat(s1.style.left)).toBe(0);
    expect(parseFloat(s1.style.width)).toBeCloseTo(40, 0); // 4/10 = 40%
    expect(parseFloat(s2.style.left)).toBeCloseTo(40, 0);
    expect(parseFloat(s2.style.width)).toBeCloseTo(60, 0); // 6/10 = 60%
    // The two bars together span the whole axis without overlap.
    expect(parseFloat(s2.style.left) + parseFloat(s2.style.width)).toBeCloseTo(100, 0);
  });

  it('overlaps parallel branches that share a startedAt', () => {
    // Two branches kick off at the same instant — their bars must share
    // a left edge so the concurrency is visually obvious.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 'fork',
            stepType: 'parallel',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:00.100Z',
            durationMs: 100,
            output: { parallel: true, branches: ['a', 'b'] },
          }),
          entry({
            stepId: 'a',
            startedAt: '2026-01-01T00:00:00.100Z',
            completedAt: '2026-01-01T00:00:05.100Z',
            durationMs: 5_000,
          }),
          entry({
            stepId: 'b',
            startedAt: '2026-01-01T00:00:00.100Z',
            completedAt: '2026-01-01T00:00:03.100Z',
            durationMs: 3_000,
          }),
        ]}
      />
    );

    const a = screen.getByTestId('timeline-bar-fill-a');
    const b = screen.getByTestId('timeline-bar-fill-b');
    // Same left offset.
    expect(parseFloat(a.style.left)).toBeCloseTo(parseFloat(b.style.left), 1);
    // But different widths — b finishes earlier, so its bar is shorter.
    expect(parseFloat(a.style.width)).toBeGreaterThan(parseFloat(b.style.width));
  });

  it('renders a wall-clock total in the header when timestamps are present', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:02.000Z',
            durationMs: 2_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:02.000Z',
            completedAt: '2026-01-01T00:00:05.000Z',
            durationMs: 3_000,
          }),
        ]}
      />
    );
    expect(screen.getByTestId('timeline-wall-clock')).toHaveTextContent(/wall-clock 5,000 ms/);
  });

  it('numbers multiple parallel forks distinctly', () => {
    // Two `parallel` step entries → fork numbers 1 and 2 are assigned.
    const branchOutput = (branches: string[]) => ({ parallel: true, branches });
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 'fork-a',
            stepType: 'parallel',
            output: branchOutput(['b1']),
          }),
          entry({ stepId: 'b1' }),
          entry({
            stepId: 'fork-b',
            stepType: 'parallel',
            output: branchOutput(['b2']),
          }),
          entry({ stepId: 'b2' }),
        ]}
      />
    );

    expect(screen.getByText('Fork #1')).toBeInTheDocument();
    expect(screen.getByText('Fork #2')).toBeInTheDocument();
  });
});
