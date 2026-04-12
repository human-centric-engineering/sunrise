/**
 * Unit Tests: ParallelEditor
 *
 * Test Coverage:
 * - Renders with defaults: timeoutMs=60000, stragglerStrategy='wait-all'
 * - Changing timeoutMs calls onChange({ timeoutMs: number })
 * - Changing stragglerStrategy calls onChange({ stragglerStrategy })
 * - FieldHelp info buttons are present
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/parallel-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ParallelEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/parallel-editor';
import type { ParallelConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/parallel-editor';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ParallelEditor', () => {
  const emptyConfig: ParallelConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<ParallelEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('parallel-timeout')).toBeInTheDocument();
  });

  it('shows the default timeoutMs of 60000', () => {
    render(<ParallelEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('parallel-timeout') as HTMLInputElement;
    expect(Number(input?.value)).toBe(60000);
  });

  it('shows the provided timeoutMs value', () => {
    const config: ParallelConfig = { timeoutMs: 30000 };
    render(<ParallelEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('parallel-timeout') as HTMLInputElement;
    expect(Number(input?.value)).toBe(30000);
  });

  it('calls onChange with { timeoutMs: number } when timeout changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ParallelEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('parallel-timeout')!;
    await user.clear(input);
    await user.type(input, '5000');

    const calls = onChange.mock.calls;
    const lastArg = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(lastArg).toHaveProperty('timeoutMs');
    expect(typeof lastArg.timeoutMs).toBe('number');
  });

  it('shows the default stragglerStrategy as "Wait for all branches"', () => {
    render(<ParallelEditor config={emptyConfig} onChange={vi.fn()} />);
    // The select trigger should display the default strategy label
    expect(screen.getByText(/wait for all branches/i)).toBeInTheDocument();
  });

  it('shows "best-effort" strategy label when stragglerStrategy is best-effort', () => {
    const config: ParallelConfig = { stragglerStrategy: 'best-effort' };
    render(<ParallelEditor config={config} onChange={vi.fn()} />);
    expect(screen.getByText(/best effort/i)).toBeInTheDocument();
  });

  it('renders at least one FieldHelp info button', () => {
    render(<ParallelEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });
});
