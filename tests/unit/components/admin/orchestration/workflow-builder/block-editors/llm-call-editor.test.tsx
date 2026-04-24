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
});
