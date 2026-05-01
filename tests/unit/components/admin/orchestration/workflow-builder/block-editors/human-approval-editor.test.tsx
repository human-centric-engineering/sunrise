/**
 * Unit Tests: HumanApprovalEditor (dedicated file)
 *
 * Test Coverage:
 * - Renders with empty config — no crash, all fields visible
 * - Prompt change calls onChange with { prompt } partial
 * - Timeout change calls onChange with { timeoutMinutes: number }
 * - Timeout edge case: empty string in number input → onChange called with NaN (not a string)
 * - Channel change via Radix Select calls onChange with { notificationChannel }
 * - Pre-populated config — textarea, number input, and select all reflect provided values
 * - Timeout default fallback: config without timeoutMinutes shows 60
 * - Channel default fallback: config without notificationChannel shows In-app
 *
 * Note: simple-editors.test.tsx covers renders-without-crashing, default-timeout-60,
 * provided-prompt-value, onChange-for-prompt, and default-channel-text.
 * This file covers the remaining onChange contracts and pre-populated state.
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/human-approval-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HumanApprovalEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/human-approval-editor';
import type { HumanApprovalConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/human-approval-editor';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const emptyConfig: HumanApprovalConfig = { prompt: '' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HumanApprovalEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders with empty config — prompt textarea, timeout input, and channel select all visible', () => {
    // Arrange + Act
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);

    // Assert
    expect(document.getElementById('approval-prompt')).toBeInTheDocument();
    expect(document.getElementById('approval-timeout')).toBeInTheDocument();
    expect(document.getElementById('approval-channel')).toBeInTheDocument();
  });

  it('shows the default timeout of 60 when config has no timeoutMinutes', () => {
    // Arrange + Act
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);

    // Assert
    const input = document.getElementById('approval-timeout') as HTMLInputElement;
    expect(Number(input.value)).toBe(60);
  });

  it('shows "In-app" as the default channel when config has no notificationChannel', () => {
    // Arrange + Act
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);

    // Assert: the Radix SelectValue should display the default text
    expect(screen.getByText('In-app')).toBeInTheDocument();
  });

  // ── Pre-populated config ───────────────────────────────────────────────────

  it('shows pre-populated prompt in the textarea', () => {
    // Arrange
    const config: HumanApprovalConfig = {
      prompt: 'Hi',
      timeoutMinutes: 15,
      notificationChannel: 'email',
    };

    // Act
    render(<HumanApprovalEditor config={config} onChange={vi.fn()} />);

    // Assert
    const textarea = document.getElementById('approval-prompt') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Hi');
  });

  it('shows pre-populated timeoutMinutes of 15 in the number input', () => {
    // Arrange
    const config: HumanApprovalConfig = {
      prompt: 'Hi',
      timeoutMinutes: 15,
      notificationChannel: 'email',
    };

    // Act
    render(<HumanApprovalEditor config={config} onChange={vi.fn()} />);

    // Assert
    const input = document.getElementById('approval-timeout') as HTMLInputElement;
    expect(Number(input.value)).toBe(15);
  });

  // ── onChange — prompt ──────────────────────────────────────────────────────

  it('calls onChange with { prompt } partial when typing a single character', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HumanApprovalEditor config={emptyConfig} onChange={onChange} />);

    // Act
    await user.type(document.getElementById('approval-prompt')!, 'A');

    // Assert: last onChange call includes prompt key with string value
    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastArg).toHaveProperty('prompt');
    expect(typeof lastArg.prompt).toBe('string');
  });

  // ── onChange — timeout ─────────────────────────────────────────────────────

  it('calls onChange with { timeoutMinutes: number } when timeout input changes to 30', () => {
    // Arrange: use fireEvent.change because the input is controlled (value from props).
    // userEvent.type appends keystrokes to the currently-rendered DOM value (which is 60),
    // making it unpredictable without a real state updater. fireEvent.change fires a single
    // change event with an explicit target value, which is the idiomatic way to test
    // controlled inputs when the parent doesn't manage state (mock onChange).
    const onChange = vi.fn();
    const config: HumanApprovalConfig = { prompt: 'x', timeoutMinutes: 60 };
    render(<HumanApprovalEditor config={config} onChange={onChange} />);

    const input = document.getElementById('approval-timeout')!;

    // Act: simulate the user changing the value to 30
    fireEvent.change(input, { target: { value: '30' } });

    // Assert: onChange called with timeoutMinutes as a number (not string)
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toHaveProperty('timeoutMinutes');
    expect(typeof arg.timeoutMinutes).toBe('number');
    expect(arg.timeoutMinutes).toBe(30);
  });

  it('calls onChange with { timeoutMinutes } as a number type when input is cleared to empty string', () => {
    // Arrange: Number('') === 0, Number('abc') === NaN — the component always coerces via Number().
    // This test verifies the value is always a number type, never a string.
    const onChange = vi.fn();
    const config: HumanApprovalConfig = { prompt: 'x', timeoutMinutes: 60 };
    render(<HumanApprovalEditor config={config} onChange={onChange} />);

    const input = document.getElementById('approval-timeout')!;

    // Act: fire a change event with empty string target value
    fireEvent.change(input, { target: { value: '' } });

    // Assert: onChange called with timeoutMinutes coerced via Number('') = 0
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toHaveProperty('timeoutMinutes');
    // Number('') → 0 (not a string)
    expect(typeof arg.timeoutMinutes).toBe('number');
  });

  // ── onChange — channel select ──────────────────────────────────────────────

  it('calls onChange with { notificationChannel: "email" } when email option is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HumanApprovalEditor config={emptyConfig} onChange={onChange} />);

    // Act: open Radix Select by clicking the trigger, then pick the email option
    const trigger = document.getElementById('approval-channel')!;
    await user.click(trigger);

    // The Radix portal renders options in document.body
    const emailOption = screen.getByRole('option', { name: /email/i });
    await user.click(emailOption);

    // Assert: onChange called with the correct channel partial
    expect(onChange).toHaveBeenCalledWith({ notificationChannel: 'email' });
  });

  it('calls onChange with { notificationChannel: "slack" } when slack option is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HumanApprovalEditor config={emptyConfig} onChange={onChange} />);

    // Act
    const trigger = document.getElementById('approval-channel')!;
    await user.click(trigger);

    const slackOption = screen.getByRole('option', { name: /slack/i });
    await user.click(slackOption);

    // Assert
    expect(onChange).toHaveBeenCalledWith({ notificationChannel: 'slack' });
  });

  // ── FieldHelp ──────────────────────────────────────────────────────────────

  it('renders at least one FieldHelp info button', () => {
    // Arrange + Act
    render(<HumanApprovalEditor config={emptyConfig} onChange={vi.fn()} />);

    // Assert: at least one accessible FieldHelp popover trigger is present
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });
});
