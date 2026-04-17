/**
 * Unit Tests: EvaluateEditor
 *
 * Test Coverage:
 * - Renders without crashing with minimal config
 * - Shows default scaleMin (1) and scaleMax (5) when not provided
 * - Shows provided rubric value in the textarea
 * - Empty threshold input when threshold is not set
 * - Shows provided threshold value
 * - Typing in rubric textarea calls onChange with { rubric }
 * - Changing scaleMin calls onChange with { scaleMin: number }
 * - Changing scaleMax calls onChange with { scaleMax: number }
 * - Changing threshold calls onChange with { threshold: number }
 * - Clearing threshold calls onChange with { threshold: undefined }
 * - Two FieldHelp info buttons are present (Rubric and Threshold)
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/evaluate-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluateEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/evaluate-editor';
import type { EvaluateConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/evaluate-editor';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const emptyConfig: EvaluateConfig = { rubric: '' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluateEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders without crashing', () => {
    render(<EvaluateEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('evaluate-rubric')).toBeInTheDocument();
  });

  it('shows the default scaleMin value of 1 when not provided', () => {
    render(<EvaluateEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-scale-min') as HTMLInputElement;
    expect(Number(input?.value)).toBe(1);
  });

  it('shows the default scaleMax value of 5 when not provided', () => {
    render(<EvaluateEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-scale-max') as HTMLInputElement;
    expect(Number(input?.value)).toBe(5);
  });

  it('shows an empty threshold input when threshold is not set', () => {
    render(<EvaluateEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-threshold') as HTMLInputElement;
    expect(input?.value).toBe('');
  });

  it('shows the provided rubric value', () => {
    const config: EvaluateConfig = { rubric: 'Rate on clarity and accuracy' };
    render(<EvaluateEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('evaluate-rubric') as HTMLTextAreaElement;
    expect(ta?.value).toBe('Rate on clarity and accuracy');
  });

  it('shows the provided scaleMin value', () => {
    const config: EvaluateConfig = { rubric: '', scaleMin: 0 };
    render(<EvaluateEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-scale-min') as HTMLInputElement;
    expect(Number(input?.value)).toBe(0);
  });

  it('shows the provided scaleMax value', () => {
    const config: EvaluateConfig = { rubric: '', scaleMax: 10 };
    render(<EvaluateEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-scale-max') as HTMLInputElement;
    expect(Number(input?.value)).toBe(10);
  });

  it('shows the provided threshold value', () => {
    const config: EvaluateConfig = { rubric: '', threshold: 3 };
    render(<EvaluateEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('evaluate-threshold') as HTMLInputElement;
    expect(Number(input?.value)).toBe(3);
  });

  it('renders at least two FieldHelp info buttons (Rubric and Threshold)', () => {
    render(<EvaluateEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(2);
  });

  // ── Callbacks ───────────────────────────────────────────────────────────────

  it('calls onChange with { rubric } when typing in the rubric textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('evaluate-rubric')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('rubric');
    expect(typeof lastArg.rubric).toBe('string');
  });

  it('calls onChange with { scaleMin: number } when scale min changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('evaluate-scale-min')!;
    await user.clear(input);
    await user.type(input, '0');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('scaleMin');
    expect(typeof lastArg.scaleMin).toBe('number');
  });

  it('calls onChange with { scaleMax: number } when scale max changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('evaluate-scale-max')!;
    await user.clear(input);
    await user.type(input, '10');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('scaleMax');
    expect(typeof lastArg.scaleMax).toBe('number');
  });

  it('calls onChange with { threshold: number } when a numeric threshold is entered', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('evaluate-threshold')!, '3');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('threshold');
    expect(typeof lastArg.threshold).toBe('number');
    expect(lastArg.threshold).toBe(3);
  });

  it('calls onChange with { threshold: undefined } when threshold input is cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: EvaluateConfig = { rubric: '', threshold: 3 };
    render(<EvaluateEditor config={config} onChange={onChange} />);

    const input = document.getElementById('evaluate-threshold')!;
    await user.clear(input);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('threshold');
    expect(lastArg.threshold).toBeUndefined();
  });

  it('falls back to scaleMin of 1 when an invalid (non-numeric) value is entered', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('evaluate-scale-min')!;
    // Clear the field so the onChange fires with a non-numeric string
    await user.clear(input);

    // After clearing, the component calls onChange({ scaleMin: 1 }) as fallback
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.scaleMin).toBe(1);
  });

  it('falls back to scaleMax of 5 when an invalid (non-numeric) value is entered', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EvaluateEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('evaluate-scale-max')!;
    await user.clear(input);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg.scaleMax).toBe(5);
  });
});
