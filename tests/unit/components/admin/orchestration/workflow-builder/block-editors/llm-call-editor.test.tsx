/**
 * Unit Tests: LlmCallEditor
 *
 * Test Coverage:
 * - Renders with default config (empty prompt)
 * - Typing in prompt textarea calls onChange({ prompt })
 * - Typing in modelOverride input calls onChange({ modelOverride })
 * - Temperature input binds to config.temperature
 * - FieldHelp ⓘ popover present (at least one info button)
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/llm-call-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LlmCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/llm-call-editor';
import type { LlmCallConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/llm-call-editor';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LlmCallEditor', () => {
  const defaultConfig: LlmCallConfig = { prompt: '', modelOverride: '', temperature: 0.7 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('llm-prompt')).toBeInTheDocument();
  });

  it('shows the current prompt value in the textarea', () => {
    const config: LlmCallConfig = { prompt: 'Say hello', modelOverride: '', temperature: 0.7 };
    render(<LlmCallEditor config={config} onChange={vi.fn()} />);

    const textarea = document.getElementById('llm-prompt') as HTMLTextAreaElement;
    expect(textarea?.value).toBe('Say hello');
  });

  it('calls onChange with updated prompt when user types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LlmCallEditor config={defaultConfig} onChange={onChange} />);

    const textarea = document.getElementById('llm-prompt')!;
    await user.type(textarea, 'A');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'A' }));
  });

  it('calls onChange with { prompt } partial containing the full typed value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: LlmCallConfig = { prompt: 'Existing', modelOverride: '', temperature: 0.7 };
    render(<LlmCallEditor config={config} onChange={onChange} />);

    const textarea = document.getElementById('llm-prompt')!;
    await user.type(textarea, '!');

    const calls = onChange.mock.calls;
    expect(calls[calls.length - 1][0]).toEqual({ prompt: 'Existing!' });
  });

  it('calls onChange with { modelOverride } when user types in the model override field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LlmCallEditor config={defaultConfig} onChange={onChange} />);

    const modelInput = document.getElementById('llm-model-override')!;
    // Type a single character so e.target.value reflects that character (controlled
    // component — the test does not re-render with updated props between keystrokes).
    await user.type(modelInput, 'x');

    expect(onChange).toHaveBeenCalledWith({ modelOverride: 'x' });
  });

  it('shows the current temperature value', () => {
    const config: LlmCallConfig = { prompt: '', modelOverride: '', temperature: 0.5 };
    render(<LlmCallEditor config={config} onChange={vi.fn()} />);

    const tempInput = document.getElementById('llm-temperature') as HTMLInputElement;
    expect(Number(tempInput?.value)).toBe(0.5);
  });

  it('calls onChange with { temperature: number } when temperature input changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LlmCallEditor config={defaultConfig} onChange={onChange} />);

    const tempInput = document.getElementById('llm-temperature')!;
    await user.clear(tempInput);
    await user.type(tempInput, '0.3');

    const calls = onChange.mock.calls;
    const lastArg = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(lastArg).toHaveProperty('temperature');
    expect(typeof lastArg.temperature).toBe('number');
  });

  it('renders at least one FieldHelp info button', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── Max tokens field ───────────────────────────────────────────────────────

  it('renders the max tokens input', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('llm-max-tokens')).toBeInTheDocument();
  });

  it('shows empty max tokens field when maxTokens is not set', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    const input = document.getElementById('llm-max-tokens') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('shows a provided maxTokens value', () => {
    const config: LlmCallConfig = {
      prompt: '',
      modelOverride: '',
      temperature: 0.7,
      maxTokens: 2048,
    };
    render(<LlmCallEditor config={config} onChange={vi.fn()} />);
    const input = document.getElementById('llm-max-tokens') as HTMLInputElement;
    expect(Number(input.value)).toBe(2048);
  });

  it('calls onChange with { maxTokens: number } when a value is entered in max tokens', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LlmCallEditor config={defaultConfig} onChange={onChange} />);

    // Act — type a token count
    const input = document.getElementById('llm-max-tokens')!;
    await user.type(input, '500');

    // Assert — last call carries maxTokens as a number, not a string
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('maxTokens');
    expect(typeof lastArg.maxTokens).toBe('number');
  });

  it('calls onChange with { maxTokens: undefined } when the max tokens field is cleared', async () => {
    // Arrange — start with a value so clearing produces an onChange call
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: LlmCallConfig = {
      prompt: '',
      modelOverride: '',
      temperature: 0.7,
      maxTokens: 1000,
    };
    render(<LlmCallEditor config={config} onChange={onChange} />);

    // Act — clear the field; empty value maps to undefined in the handler
    await user.clear(document.getElementById('llm-max-tokens')!);

    // Assert — maxTokens is undefined when field is blank
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('maxTokens');
    expect(lastArg.maxTokens).toBeUndefined();
  });

  // ── Response format select ─────────────────────────────────────────────────

  it('renders the response format select', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    expect(document.getElementById('llm-response-format')).toBeInTheDocument();
  });

  it('shows "text" as the default response format', () => {
    render(<LlmCallEditor config={defaultConfig} onChange={vi.fn()} />);
    const trigger = document.getElementById('llm-response-format')!;
    expect(trigger).toHaveTextContent(/text/i);
  });

  it('shows "json" when responseFormat is set to "json"', () => {
    const config: LlmCallConfig = {
      prompt: '',
      modelOverride: '',
      temperature: 0.7,
      responseFormat: 'json',
    };
    render(<LlmCallEditor config={config} onChange={vi.fn()} />);
    const trigger = document.getElementById('llm-response-format')!;
    expect(trigger).toHaveTextContent(/json/i);
  });

  it('calls onChange with { responseFormat: "json" } when user selects JSON', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LlmCallEditor config={defaultConfig} onChange={onChange} />);

    // Act — open the select and pick JSON
    await user.click(document.getElementById('llm-response-format')!);
    await user.click(screen.getByRole('option', { name: /json/i }));

    // Assert — onChange called once with the correct format literal
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ responseFormat: 'json' });
  });

  it('calls onChange with { responseFormat: "text" } when user switches back to text', async () => {
    // Arrange — start with JSON selected
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: LlmCallConfig = {
      prompt: '',
      modelOverride: '',
      temperature: 0.7,
      responseFormat: 'json',
    };
    render(<LlmCallEditor config={config} onChange={onChange} />);

    // Act — open the select and pick Text
    await user.click(document.getElementById('llm-response-format')!);
    await user.click(screen.getByRole('option', { name: /^text$/i }));

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ responseFormat: 'text' });
  });
});
