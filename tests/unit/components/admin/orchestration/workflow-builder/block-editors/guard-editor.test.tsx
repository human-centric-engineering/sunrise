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

  // ── LLM-specific onChange handlers ────────────────────────────────────────

  it('calls onChange with { modelOverride: string } when user types in the model override field (llm mode)', async () => {
    // Arrange — mode must be "llm" for the field to be visible
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={onChange} />);

    // Act — type a single character so the controlled input fires exactly one onChange
    await user.type(document.getElementById('guard-model-override')!, 'x');

    // Assert — onChange was called with the modelOverride key
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('modelOverride');
    expect(lastArg.modelOverride).toBe('x');
  });

  it('calls onChange with { temperature: number } when the temperature input changes (llm mode)', async () => {
    // Arrange — mode must be "llm" for the temperature field to render
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };
    render(<GuardEditor config={config} onChange={onChange} />);

    // Act
    const input = document.getElementById('guard-temperature')!;
    await user.clear(input);
    await user.type(input, '0.5');

    // Assert — the temperature value passed to onChange is a number, not a string
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('temperature');
    expect(typeof lastArg.temperature).toBe('number');
  });

  // ── Defensive defaults when config arrives without the required fields ────

  // A workflow JSON can land in the editor before any field has been touched —
  // the engine validator gates the missing-field case at execution time, but
  // the editor must still render so the operator can fill it in. These tests
  // exercise the `?? default` short-circuits for every field.
  it('renders with sensible defaults when every config field is absent', () => {
    // Cast through `unknown` — the prop type requires rules/mode/failAction
    // but the editor is designed to tolerate undefined values on every field.
    const empty = {} as unknown as GuardConfig;
    render(<GuardEditor config={empty} onChange={vi.fn()} />);

    const rules = document.getElementById('guard-rules') as HTMLTextAreaElement;
    expect(rules.value).toBe('');

    expect(document.getElementById('guard-mode')!).toHaveTextContent('LLM');
    expect(document.getElementById('guard-fail-action')!).toHaveTextContent('Block');

    // failAction defaulted to 'block' → retry input is rendered
    const retries = document.getElementById('guard-max-retries') as HTMLInputElement;
    expect(retries).toBeInTheDocument();
    expect(retries.value).toBe('0');

    // mode defaulted to 'llm' → LLM-specific fields are rendered
    expect(document.getElementById('guard-model-override')).toBeInTheDocument();
    expect(document.getElementById('guard-temperature')).toBeInTheDocument();
  });

  it('shows singular "retry attempt" (no trailing s) when maxRetries is exactly 1', () => {
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 1 };
    render(<GuardEditor config={config} onChange={vi.fn()} />);

    // Exact phrase — the alternate branch ("attempts") must NOT match.
    expect(screen.getByText(/up to 1 retry attempt\./i)).toBeInTheDocument();
    expect(screen.queryByText(/retry attempts\./i)).not.toBeInTheDocument();
  });

  it("coerces an empty maxRetries input to 0 via the `Number('') || 0` fallback", () => {
    const onChange = vi.fn();
    const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block', maxRetries: 5 };
    render(<GuardEditor config={config} onChange={onChange} />);

    const input = document.getElementById('guard-max-retries') as HTMLInputElement;
    // Empty string → Number('') is NaN → falsy → || 0 kicks in.
    // Without that fallback the field would propagate NaN through to the
    // engine and the workflow validator would later reject the step.
    fireEvent.change(input, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ maxRetries: 0 });
  });

  // ── Schema mode ─────────────────────────────────────────────────────────
  // Selecting Schema mode swaps the panel into a different layout —
  // no Rules textarea, no LLM-only fields, and two new inputs for the
  // schema name and (optional) input step id. These tests pin both
  // the visibility and the round-trip wiring.
  describe('schema mode', () => {
    it('renders the schema name and input step id inputs when mode is schema', () => {
      const config: GuardConfig = {
        rules: '',
        mode: 'schema',
        failAction: 'block',
        schemaName: 'audit-proposals',
      };
      render(<GuardEditor config={config} onChange={vi.fn()} />);

      const nameInput = document.getElementById('guard-schema-name') as HTMLInputElement;
      const stepInput = document.getElementById('guard-input-step-id') as HTMLInputElement;
      expect(nameInput).toBeInTheDocument();
      expect(stepInput).toBeInTheDocument();
      expect(nameInput.value).toBe('audit-proposals');
    });

    it('hides the Rules textarea in schema mode (schema mode keys off schemaName, not rules)', () => {
      const config: GuardConfig = {
        rules: 'leftover',
        mode: 'schema',
        failAction: 'block',
        schemaName: 'demo',
      };
      render(<GuardEditor config={config} onChange={vi.fn()} />);

      // The Rules textarea is hidden so an author isn't confused by
      // a visible field that does nothing in this mode.
      expect(document.getElementById('guard-rules')).not.toBeInTheDocument();
    });

    it('hides the LLM-only fields (model override, temperature) in schema mode', () => {
      const config: GuardConfig = {
        rules: '',
        mode: 'schema',
        failAction: 'block',
        schemaName: 'demo',
      };
      render(<GuardEditor config={config} onChange={vi.fn()} />);

      // Schema mode is deterministic — these only matter for LLM mode.
      expect(document.getElementById('guard-model-override')).not.toBeInTheDocument();
      expect(document.getElementById('guard-temperature')).not.toBeInTheDocument();
    });

    it('typing in the schema name input fires onChange({ schemaName })', () => {
      const onChange = vi.fn();
      const config: GuardConfig = {
        rules: '',
        mode: 'schema',
        failAction: 'block',
        schemaName: '',
      };
      render(<GuardEditor config={config} onChange={onChange} />);

      const input = document.getElementById('guard-schema-name') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'audit-proposals' } });

      expect(onChange).toHaveBeenCalledWith({ schemaName: 'audit-proposals' });
    });

    it('typing in the input step id input fires onChange({ inputStepId })', () => {
      const onChange = vi.fn();
      const config: GuardConfig = {
        rules: '',
        mode: 'schema',
        failAction: 'block',
        schemaName: 'demo',
      };
      render(<GuardEditor config={config} onChange={onChange} />);

      const input = document.getElementById('guard-input-step-id') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'analyse_chat' } });

      expect(onChange).toHaveBeenCalledWith({ inputStepId: 'analyse_chat' });
    });

    it('schema mode dropdown option is available and switching to it fires onChange({ mode: schema })', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      const config: GuardConfig = { rules: '', mode: 'llm', failAction: 'block' };
      render(<GuardEditor config={config} onChange={onChange} />);

      const trigger = document.getElementById('guard-mode')!;
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: /^schema$/i }));

      expect(onChange).toHaveBeenCalledWith({ mode: 'schema' });
    });
  });
});
