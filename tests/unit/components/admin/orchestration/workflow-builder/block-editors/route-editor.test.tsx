/**
 * Unit Tests: RouteEditor
 *
 * Test Coverage:
 * - Renders existing routes from config
 * - Add button appends a new branch entry via onChange
 * - Remove button removes a branch
 * - Renaming a label calls onChange with the updated routes array
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/route-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RouteEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/route-editor';
import type { RouteConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/route-editor';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RouteEditor', () => {
  const emptyConfig: RouteConfig = { classificationPrompt: '', routes: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing with no routes', () => {
    render(<RouteEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('route-classification')).toBeInTheDocument();
  });

  it('renders existing routes from config', () => {
    const config: RouteConfig = {
      classificationPrompt: 'Classify',
      routes: [{ label: 'yes' }, { label: 'no' }],
    };
    render(<RouteEditor config={config} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue('yes')).toBeInTheDocument();
    expect(screen.getByDisplayValue('no')).toBeInTheDocument();
  });

  it('clicking Add branch calls onChange with an appended branch', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: RouteConfig = {
      classificationPrompt: '',
      routes: [{ label: 'yes' }],
    };
    render(<RouteEditor config={config} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add branch/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [arg] = onChange.mock.calls[0];
    expect(arg.routes).toHaveLength(2);
    expect(arg.routes[0]).toEqual({ label: 'yes' });
  });

  it('clicking Add branch on empty routes produces a routes array with one entry', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RouteEditor config={emptyConfig} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add branch/i }));

    const [arg] = onChange.mock.calls[0];
    expect(Array.isArray(arg.routes)).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    expect(arg.routes).toHaveLength(1);
  });

  it('clicking Remove button calls onChange with the branch removed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: RouteConfig = {
      classificationPrompt: '',
      routes: [{ label: 'yes' }, { label: 'no' }],
    };
    render(<RouteEditor config={config} onChange={onChange} />);

    // Remove the first branch
    const removeBtns = screen.getAllByRole('button', { name: /remove branch/i });
    await user.click(removeBtns[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [arg] = onChange.mock.calls[0];
    expect(arg.routes).toHaveLength(1);
    expect(arg.routes[0]).toEqual({ label: 'no' });
  });

  it('typing a new label calls onChange with the updated routes array', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: RouteConfig = {
      classificationPrompt: '',
      routes: [{ label: 'yes' }],
    };
    render(<RouteEditor config={config} onChange={onChange} />);

    const labelInput = screen.getByDisplayValue('yes');
    await user.type(labelInput, 's');

    // Last onChange call should contain the updated label
    const calls = onChange.mock.calls;
    const lastArg = calls[calls.length - 1][0];
    expect(lastArg.routes[0].label).toBe('yess');
  });

  it('updating classification prompt calls onChange with { classificationPrompt }', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RouteEditor config={emptyConfig} onChange={onChange} />);

    const prompt = document.getElementById('route-classification')!;
    await user.type(prompt, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('classificationPrompt');
  });

  it('shows a placeholder message when no routes are present', () => {
    render(<RouteEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(screen.getByText(/no branches yet/i)).toBeInTheDocument();
  });
});
