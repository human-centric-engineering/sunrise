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
import { render, screen } from '@testing-library/react';
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
    const select = document.getElementById('guard-mode') as HTMLSelectElement;
    expect(select.value).toBe('llm');
  });

  it('defaults fail-action select to "block" when config.failAction is "block"', () => {
    render(<GuardEditor config={defaultConfig} onChange={vi.fn()} />);
    const select = document.getElementById('guard-fail-action') as HTMLSelectElement;
    expect(select.value).toBe('block');
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
    const select = document.getElementById('guard-mode') as HTMLSelectElement;
    expect(select.value).toBe('regex');
  });

  it('shows "flag" when config.failAction is "flag"', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'flag' };
    render(<GuardEditor config={config} onChange={vi.fn()} />);
    const select = document.getElementById('guard-fail-action') as HTMLSelectElement;
    expect(select.value).toBe('flag');
  });

  // ── onChange callbacks — rules textarea ────────────────────────────────────

  it('calls onChange with { rules } when user types in the rules textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GuardEditor config={defaultConfig} onChange={onChange} />);

    await user.type(document.getElementById('guard-rules')!, 'A');

    expect(onChange).toHaveBeenCalled();
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

    await user.selectOptions(document.getElementById('guard-mode')!, 'regex');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ mode: 'regex' });
  });

  it('calls onChange with { mode: "llm" } when user selects llm', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'regex', failAction: 'block' };
    render(<GuardEditor config={config} onChange={onChange} />);

    await user.selectOptions(document.getElementById('guard-mode')!, 'llm');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ mode: 'llm' });
  });

  // ── onChange callbacks — fail-action select ───────────────────────────────

  it('calls onChange with { failAction: "flag" } when user selects flag', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GuardEditor config={defaultConfig} onChange={onChange} />);

    await user.selectOptions(document.getElementById('guard-fail-action')!, 'flag');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ failAction: 'flag' });
  });

  it('calls onChange with { failAction: "block" } when user selects block', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'flag' };
    render(<GuardEditor config={config} onChange={onChange} />);

    await user.selectOptions(document.getElementById('guard-fail-action')!, 'block');

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
});
