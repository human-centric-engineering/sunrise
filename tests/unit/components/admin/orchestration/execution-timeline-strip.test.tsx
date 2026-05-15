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

/**
 * Test fixture for ExecutionTraceEntry. The strip's displayed Duration
 * value is the wall-clock delta between `startedAt` and `completedAt`
 * (so the bar's visual length agrees with the number). For tests that
 * want a specific displayed duration, override `durationMs` AND override
 * `completedAt` to match — or omit both and rely on the 1s default.
 */
function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  const startedAt = overrides.startedAt ?? '2026-01-01T00:00:00.000Z';
  const durationMs = overrides.durationMs ?? 1000;
  const completedAt =
    'completedAt' in overrides
      ? overrides.completedAt
      : new Date(new Date(startedAt).getTime() + durationMs).toISOString();
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step 1',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt,
    completedAt,
    durationMs,
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

  it('marks skipped entries with data-status="skipped" and a muted/faded bar', () => {
    render(
      <ExecutionTimelineStrip
        trace={[entry({ stepId: 'a' }), entry({ stepId: 'b', status: 'skipped' })]}
      />
    );
    const bar = screen.getByTestId('timeline-bar-b');
    expect(bar).toHaveAttribute('data-status', 'skipped');
    const inner = bar.querySelector('span[style]');
    expect(inner?.className).toContain('bg-muted-foreground/30');
    expect(inner?.className).toContain('opacity-60');
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

  // ─── Step-type colours (workflow-builder palette) ──────────────────────

  it('renders the agent category colour for llm_call steps', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'a', stepType: 'llm_call' }),
          entry({ stepId: 'b', stepType: 'llm_call' }),
        ]}
      />
    );
    const bar = screen.getByTestId('timeline-bar-a');
    expect(bar).toHaveAttribute('data-category', 'agent');
    const inner = screen.getByTestId('timeline-bar-fill-a');
    expect(inner.className).toContain('bg-blue-500');
  });

  it('renders the decision category colour for route steps', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'r', stepType: 'route' }),
          entry({ stepId: 'a', stepType: 'llm_call' }),
        ]}
      />
    );
    const bar = screen.getByTestId('timeline-bar-r');
    expect(bar).toHaveAttribute('data-category', 'decision');
    expect(screen.getByTestId('timeline-bar-fill-r').className).toContain('bg-amber-500');
  });

  it('renders the output category colour for send_notification steps', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'n', stepType: 'send_notification' }),
          entry({ stepId: 'a', stepType: 'llm_call' }),
        ]}
      />
    );
    expect(screen.getByTestId('timeline-bar-n')).toHaveAttribute('data-category', 'output');
    expect(screen.getByTestId('timeline-bar-fill-n').className).toContain('bg-emerald-500');
  });

  it('lets red failed-status override the category colour', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'a', stepType: 'llm_call' }),
          entry({ stepId: 'b', stepType: 'llm_call', status: 'failed' }),
        ]}
      />
    );
    const inner = screen.getByTestId('timeline-bar-fill-b');
    // Failure dominates — bar is red, not the agent-category blue.
    expect(inner.className).toContain('bg-red-500');
    expect(inner.className).not.toContain('bg-blue-500');
  });

  // ─── No curves on bars ──────────────────────────────────────────────────

  it('does not apply rounded corners to bar lanes or fills', () => {
    render(<ExecutionTimelineStrip trace={[entry({ stepId: 'a' }), entry({ stepId: 'b' })]} />);
    const bar = screen.getByTestId('timeline-bar-a');
    const lane = bar.querySelector('.relative.h-4');
    const fill = screen.getByTestId('timeline-bar-fill-a');
    expect(lane?.className ?? '').not.toMatch(/\brounded(-|\b)/);
    expect(fill.className).not.toMatch(/\brounded(-|\b)/);
  });

  // ─── Compress-waits toggle ──────────────────────────────────────────────

  it('hides the compress-waits toggle when no awaiting_approval steps are present', () => {
    render(<ExecutionTimelineStrip trace={[entry({ stepId: 'a' }), entry({ stepId: 'b' })]} />);
    expect(screen.queryByTestId('timeline-compress-waits')).not.toBeInTheDocument();
  });

  it('shows the toggle when awaiting_approval is in the trace and compresses on click', async () => {
    const user = userEvent.setup();
    // 10s total: s1 [0–4s], wait [4s–6s] = 2s, s2 [6s–10s] = 4s.
    // wait/total = 0.2 — below the 0.5 auto-compress threshold so the
    // toggle starts OFF and we exercise the click → compress transition.
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
            stepId: 'wait',
            status: 'awaiting_approval',
            stepType: 'human_approval',
            startedAt: '2026-01-01T00:00:04.000Z',
            completedAt: '2026-01-01T00:00:06.000Z',
            durationMs: 2_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:06.000Z',
            completedAt: '2026-01-01T00:00:10.000Z',
            durationMs: 4_000,
          }),
        ]}
      />
    );

    const toggle = screen.getByTestId('timeline-compress-waits');
    expect(toggle).toHaveTextContent(/^compress waits$/i);

    // Before compression: 10s axis. wait bar widthPct = 2 / 10 = 20%.
    const waitFill = screen.getByTestId('timeline-bar-fill-wait');
    expect(parseFloat(waitFill.style.width)).toBeCloseTo(20, 0);

    await user.click(toggle);

    expect(screen.getByTestId('timeline-compress-waits')).toHaveTextContent(/compressed waits/i);
    // After compression: axis = 4 + 1 (collapsed wait) + 4 = 9s.
    // wait bar shrinks to 1/9 ≈ 11%. s2 shifts left to (4+1)/9 ≈ 56%.
    expect(parseFloat(screen.getByTestId('timeline-bar-fill-wait').style.width)).toBeCloseTo(
      11.11,
      1
    );
    expect(parseFloat(screen.getByTestId('timeline-bar-fill-s2').style.left)).toBeCloseTo(55.56, 1);
    // The compressed wait bar carries a data-compressed flag for styling
    // hooks and gets the hashed pattern class.
    expect(screen.getByTestId('timeline-bar-wait')).toHaveAttribute('data-compressed', 'true');
    expect(screen.getByTestId('timeline-bar-fill-wait').className).toContain(
      'repeating-linear-gradient'
    );
  });

  it('auto-defaults to compressed when an approval wait exceeds 15 s wall-clock', async () => {
    const user = userEvent.setup();
    // 20 s wait — over the 15 s auto-compress threshold.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
            durationMs: 1_000,
          }),
          entry({
            stepId: 'wait',
            status: 'awaiting_approval',
            stepType: 'human_approval',
            startedAt: '2026-01-01T00:00:01.000Z',
            completedAt: '2026-01-01T00:00:21.000Z',
            durationMs: 20_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:21.000Z',
            completedAt: '2026-01-01T00:00:22.000Z',
            durationMs: 1_000,
          }),
        ]}
      />
    );

    const toggle = screen.getByTestId('timeline-compress-waits');
    expect(toggle).toHaveTextContent(/compressed waits/i);
    expect(toggle).toHaveAttribute('data-auto-compressed', 'true');
    expect(screen.getByTestId('timeline-bar-wait')).toHaveAttribute('data-compressed', 'true');

    // Clicking the toggle once expresses an explicit user preference to
    // turn compression OFF — the auto flag clears.
    await user.click(toggle);
    expect(screen.getByTestId('timeline-compress-waits')).toHaveTextContent(/^compress waits$/i);
    expect(screen.getByTestId('timeline-compress-waits')).not.toHaveAttribute(
      'data-auto-compressed'
    );
    expect(screen.getByTestId('timeline-bar-wait')).not.toHaveAttribute('data-compressed');
  });

  it('does NOT auto-compress when the longest approval wait is under 15 s wall-clock', () => {
    // Wait is 14 s — just under the 15 s threshold. Even if the wait
    // dominates the whole timeline by ratio, it shouldn't auto-trigger.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:00.500Z',
            durationMs: 500,
          }),
          entry({
            stepId: 'wait',
            status: 'awaiting_approval',
            stepType: 'human_approval',
            startedAt: '2026-01-01T00:00:00.500Z',
            completedAt: '2026-01-01T00:00:14.500Z',
            durationMs: 14_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:14.500Z',
            completedAt: '2026-01-01T00:00:15.000Z',
            durationMs: 500,
          }),
        ]}
      />
    );

    const toggle = screen.getByTestId('timeline-compress-waits');
    expect(toggle).toHaveTextContent(/^compress waits$/i);
    expect(toggle).not.toHaveAttribute('data-auto-compressed');
    expect(screen.getByTestId('timeline-bar-wait')).not.toHaveAttribute('data-compressed');
  });

  it('auto-compresses already-decided human_approval steps (status=completed)', () => {
    // Regression: when approval is granted, the engine flips the entry's
    // status from 'awaiting_approval' to 'completed' but keeps
    // stepType='human_approval'. Compression must still apply, otherwise
    // historical runs render the full wall-clock pause and the toggle
    // doesn't even appear.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
            durationMs: 1_000,
          }),
          entry({
            stepId: 'wait',
            stepType: 'human_approval',
            // Already approved — status is 'completed', not 'awaiting'.
            status: 'completed',
            startedAt: '2026-01-01T00:00:01.000Z',
            completedAt: '2026-01-01T00:00:24.008Z',
            // Engine records ~1ms processing time on the click; wall-clock
            // delta is ~23 s, which is over the 15 s auto-trigger.
            durationMs: 1,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:24.008Z',
            completedAt: '2026-01-01T00:00:25.008Z',
            durationMs: 1_000,
          }),
        ]}
      />
    );

    const toggle = screen.getByTestId('timeline-compress-waits');
    expect(toggle).toHaveTextContent(/compressed waits/i);
    expect(toggle).toHaveAttribute('data-auto-compressed', 'true');
    expect(screen.getByTestId('timeline-bar-wait')).toHaveAttribute('data-compressed', 'true');
  });

  it('displays wall-clock elapsed (not entry.durationMs) for awaiting_approval bars', () => {
    // The engine records entry.durationMs as the executor's own processing
    // time — ~1ms for a human-approval click. The wall-clock is the long
    // pause. The bar uses wall-clock, so the duration text shown alongside
    // must match — anything else is misleading.
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
            durationMs: 1_000,
          }),
          entry({
            stepId: 'wait',
            status: 'awaiting_approval',
            stepType: 'human_approval',
            startedAt: '2026-01-01T00:00:01.000Z',
            // 5s of wall-clock pause; engine recorded 1ms processing time.
            completedAt: '2026-01-01T00:00:06.000Z',
            durationMs: 1,
          }),
        ]}
      />
    );

    // 5,000 ms (the wall-clock) appears, NOT 1 ms.
    expect(screen.getByText(/5,000 ms/)).toBeInTheDocument();
    expect(screen.queryByText(/^1 ms$/)).not.toBeInTheDocument();
  });

  // ─── Hover tooltip ──────────────────────────────────────────────────────

  it('renders a Radix tooltip with start/end/duration and step-type description on hover', async () => {
    const user = userEvent.setup();
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 'a',
            stepType: 'llm_call',
            label: 'Generate plan',
            startedAt: '2026-01-01T08:00:00.000Z',
            completedAt: '2026-01-01T08:00:02.500Z',
            durationMs: 2_500,
          }),
          entry({
            stepId: 'b',
            stepType: 'llm_call',
            startedAt: '2026-01-01T08:00:02.500Z',
            completedAt: '2026-01-01T08:00:03.500Z',
            durationMs: 1_000,
          }),
        ]}
      />
    );

    await user.hover(screen.getByTestId('timeline-bar-a'));

    // Radix portals the TooltipContent (and may also render an aria-hidden
    // duplicate for screen readers), so use findAllBy and assert at least
    // one match. The description text only appears inside the tooltip.
    const description = await screen.findAllByText(
      /single model call — the basic unit of a workflow/i,
      {},
      { timeout: 2000 }
    );
    expect(description.length).toBeGreaterThan(0);
    // Friendly type label from getStepMetadata('llm_call').label = 'LLM Call'.
    expect(screen.getAllByText(/llm call/i).length).toBeGreaterThan(0);
    // The "Started" / "Ended" labels live inside the tooltip's <dl>.
    expect(screen.getAllByText(/started/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ended/i).length).toBeGreaterThan(0);
  });

  it('surfaces the skip reason in the tooltip for skipped bars', async () => {
    // The trace row beneath the bar shows this same reason inline, but the
    // tooltip is what the user hovers when scanning bars in the Gantt
    // without scrolling — so the reason has to be available here too.
    const user = userEvent.setup();
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({ stepId: 'a' }),
          entry({
            stepId: 'b',
            status: 'skipped',
            error: 'LLM timeout after 30s',
          }),
        ]}
      />
    );

    await user.hover(screen.getByTestId('timeline-bar-b'));

    const reasons = await screen.findAllByText(/llm timeout after 30s/i, {}, { timeout: 2000 });
    expect(reasons.length).toBeGreaterThan(0);
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
    const chip = screen.getByTestId('timeline-wall-clock');
    // Raw ms total stays so the existing axis-units stay legible.
    expect(chip).toHaveTextContent(/wall-clock 5,000 ms/);
    // Plus the human-readable HH:MM:SS so long runs are scannable without
    // mental arithmetic ("is 80,179 ms ~80s or ~80m?").
    expect(chip).toHaveTextContent('(00:00:05)');
  });

  it('formats wall-clock totals over an hour with hours, minutes, and seconds', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:30.000Z',
            durationMs: 30_000,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:30.000Z',
            // 1h 23m 45s total span.
            completedAt: '2026-01-01T01:23:45.000Z',
            durationMs: 83_715_000 - 30_000,
          }),
        ]}
      />
    );
    expect(screen.getByTestId('timeline-wall-clock')).toHaveTextContent('(01:23:45)');
  });

  it('omits the HH:MM:SS suffix for sub-second wall-clock totals', () => {
    render(
      <ExecutionTimelineStrip
        trace={[
          entry({
            stepId: 's1',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:00.200Z',
            durationMs: 200,
          }),
          entry({
            stepId: 's2',
            startedAt: '2026-01-01T00:00:00.200Z',
            completedAt: '2026-01-01T00:00:00.500Z',
            durationMs: 300,
          }),
        ]}
      />
    );
    const chip = screen.getByTestId('timeline-wall-clock');
    expect(chip).toHaveTextContent('wall-clock 500 ms');
    // h:m:s would be "00:00:00" for a 500 ms run — noise, so suppress it.
    expect(chip.textContent).not.toMatch(/\(00:00:00\)/);
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
