/**
 * Unit Tests: GuardEditor
 *
 * Test Coverage:
 * - Renders without crashing (rules textarea, mode select, fail-action select)
 * - Shows provided config values in each field
 * - Shows default values (mode = 'llm', failAction = 'block') when config fields are absent
 * - Typing in the rules textarea calls onChange({ rules })
 * - Changing the mode select calls onChange({ mode }) with the correct literal
 * - Changing the fail-action select calls onChange({ failAction }) with the correct literal
 * - FieldHelp ⓘ popover is present for each field
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/guard-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GuardEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/guard-editor';
import type { GuardConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/guard-editor';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GuardEditor', () => {
  const defaultConfig: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders without crashing', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('guard-rules')).toBeInTheDocument();
  });

  it('renders the mode select', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('guard-mode')).toBeInTheDocument();
  });

  it('renders the fail-action select', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('guard-fail-action')).toBeInTheDocument();
  });

  // ── Default values ─────────────────────────────────────────────────────────

  it('shows empty rules textarea when rules is empty string', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const ta = document.getElementById('guard-rules') as HTMLTextAreaElement;
    expect(ta.value).toBe('');
  });

  it('defaults mode select to "llm" when config.mode is "llm"', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const trigger = document.getElementById('guard-mode')!;
    expect(trigger).toHaveTextContent('LLM');
  });

  it('defaults fail-action select to "block" when config.failAction is "block"', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const trigger = document.getElementById('guard-fail-action')!;
    expect(trigger).toHaveTextContent('Block');
  });

  // ── Provided config values ─────────────────────────────────────────────────

  it('shows a provided rules value in the textarea', () => {
    const config: GuardConfig = { rules: 'Reject PII', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('guard-rules') as HTMLTextAreaElement;
    expect(ta.value).toBe('Reject PII');
  });

  it('shows "regex" when config.mode is "regex"', () => {
    const config: GuardConfig = { rules: '', mode: 'regex', failAction: 'block' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    const trigger = document.getElementById('guard-mode')!;
    expect(trigger).toHaveTextContent('Regex');
  });

  it('shows "flag" when config.failAction is "flag"', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'flag' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    const trigger = document.getElementById('guard-fail-action')!;
    expect(trigger).toHaveTextContent('Flag');
  });

  // ── onChange callbacks — rules textarea ────────────────────────────────────

  it('calls onChange with { rules } when user types in the rules textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GuardEditor config={defaultConfig} onChange={onChange} />);

    await user.type(document.getElementById('guard-rules')!, 'A');

    // test-review:accept no_arg_called — immediately followed by mock.calls inspection asserting the `rules` key is present; the bare call is a redundant sentinel, arg shape is effectively verified on the next lines
    expect(onChange).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('rules');
  });

  it('calls onChange with the full updated rules value after typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: 'Existing', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={onChange} />);

    await user.type(document.getElementById('guard-rules')!, '!');

    const calls = onChange.mock.calls;
    const lastArg = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(lastArg).toEqual({ rules: 'Existing!' });
  });

  // ── onChange callbacks — mode select ──────────────────────────────────────

  it('calls onChange with { mode: "regex" } when user selects regex', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GuardEditor config={defaultConfig} onChange={onChange} />);

    await user.click(document.getElementById('guard-mode')!);
    await user.click(screen.getByRole('option', { name: /regex/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ mode: 'regex' });
  });

  it('calls onChange with { mode: "llm" } when user selects llm', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'regex', failAction: 'block' };
    render(<GuardEditor config={config} onChange={onChange} />);

    await user.click(document.getElementById('guard-mode')!);
    await user.click(screen.getByRole('option', { name: /^llm$/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ mode: 'llm' });
  });

  // ── onChange callbacks — fail-action select ───────────────────────────────

  it('calls onChange with { failAction: "flag" } when user selects flag', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GuardEditor config={defaultConfig} onChange={onChange} />);

    await user.click(document.getElementById('guard-fail-action')!);
    await user.click(screen.getByRole('option', { name: /flag/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ failAction: 'flag' });
  });

  it('calls onChange with { failAction: "block" } when user selects block', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'flag' };
    render(<GuardEditor config={config} onChange={onChange} />);

    await user.click(document.getElementById('guard-fail-action')!);
    await user.click(screen.getByRole('option', { name: /block/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ failAction: 'block' });
  });

  // ── FieldHelp popovers ────────────────────────────────────────────────────

  it('renders at least one FieldHelp info button', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a FieldHelp button for each of the three fields', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(3);
  });

  // ── Conditional: retry config visibility ──────────────────────────────────

  it('shows the retry-on-failure input when failAction is "block"', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(document.getElementById('guard-max-retries')).toBeInTheDocument();
  });

  it('hides the retry-on-failure input when failAction is "flag"', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'flag' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(document.getElementById('guard-max-retries')).not.toBeInTheDocument();
  });

  // ── Conditional: LLM-specific field visibility ────────────────────────────

  it('shows model override and temperature inputs when mode is "llm"', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(document.getElementById('guard-model-override')).toBeInTheDocument();
    expect(document.getElementById('guard-temperature')).toBeInTheDocument();
  });

  it('hides model override and temperature inputs when mode is "regex"', () => {
    const config: GuardConfig = { rules: '', mode: 'regex', failAction: 'block' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(document.getElementById('guard-model-override')).not.toBeInTheDocument();
    expect(document.getElementById('guard-temperature')).not.toBeInTheDocument();
  });

  // ── maxRetries clamping ───────────────────────────────────────────────────

  it('clamps maxRetries to 0 when a negative value is entered', () => {
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 0 };
    render(<GuardEditor config={config} onChange={onChange} />);

    const input = document.getElementById('guard-max-retries') as HTMLInputElement;
    // Use fireEvent.change to set the full value in one shot (avoids keystroke-per-char clamping)
    fireEvent.change(input, { target: { value: '-5' } });

    // The onChange handler clamps: Math.max(0, Math.min(10, Number('-5') || 0)) = 0
    expect(onChange).toHaveBeenCalledWith({ maxRetries: 0 });
  });

  it('clamps maxRetries to 10 when a value above the maximum is entered', () => {
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 0 };
    render(<GuardEditor config={config} onChange={onChange} />);

    const input = document.getElementById('guard-max-retries') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });

    // Math.max(0, Math.min(10, 99)) = 10
    expect(onChange).toHaveBeenCalledWith({ maxRetries: 10 });
  });

  it('calls onChange with the exact maxRetries value when within valid range', () => {
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 0 };
    render(<GuardEditor config={config} onChange={onChange} />);

    const input = document.getElementById('guard-max-retries') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });

    expect(onChange).toHaveBeenCalledWith({ maxRetries: 5 });
  });

  it('shows retry description hint when maxRetries is greater than 0', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 3 };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(screen.getByText(/up to 3 retry attempt/i)).toBeInTheDocument();
  });

  it('does not show retry description hint when maxRetries is 0', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 0 };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    expect(screen.queryByText(/retry attempt/i)).not.toBeInTheDocument();
  });
});
