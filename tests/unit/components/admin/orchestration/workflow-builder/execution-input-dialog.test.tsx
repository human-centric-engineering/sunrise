/**
 * Unit Tests: ExecutionInputDialog
 *
 * Covers:
 *   - Valid JSON object → onConfirm called with correct inputData
 *   - Valid budget → budgetLimitUsd forwarded
 *   - Empty budget → no budgetLimitUsd in callback
 *   - Non-numeric / zero / negative budget → error shown, no confirm
 *   - Array / plain-string JSON → "must be a JSON object" error
 *   - Malformed JSON → "not valid JSON" error
 *   - Cancel → onOpenChange(false)
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionInputDialog,
  type ExecutionInputDialogProps,
} from '@/components/admin/orchestration/workflow-builder/execution-input-dialog';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderDialog(overrides: Partial<ExecutionInputDialogProps> = {}) {
  const props: ExecutionInputDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<ExecutionInputDialog {...props} />);
  return props;
}

/** Sets the JSON textarea value via fireEvent (avoids userEvent `{` parsing). */
function setTextarea(value: string) {
  const textarea = screen.getByLabelText(/input data/i);
  fireEvent.change(textarea, { target: { value } });
}

/** Sets the budget input value via fireEvent. */
function setBudgetValue(value: string) {
  const input = screen.getByLabelText(/budget cap/i);
  fireEvent.change(input, { target: { value } });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutionInputDialog', () => {
  it('calls onConfirm with parsed inputData for valid JSON object', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('{"key": "value"}');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        inputData: expect.objectContaining({ key: 'value' }),
      })
    );
  });

  it('forwards budgetLimitUsd when a valid budget is provided', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('{"a":1}');
    setBudgetValue('0.50');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ budgetLimitUsd: 0.5 }));
  });

  it('omits budgetLimitUsd when budget field is empty', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    // Default textarea has valid JSON, budget is empty by default
    await user.click(screen.getByRole('button', { name: /run/i }));

    const call = (props.onConfirm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.budgetLimitUsd).toBeUndefined();
  });

  it('shows error for zero budget and does not call onConfirm', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setBudgetValue('0');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/positive number/i);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('shows error for negative budget and does not call onConfirm', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setBudgetValue('-5');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/positive number/i);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('shows error when input is a JSON array', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('[1,2,3]');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/JSON object/i);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('shows error when input is a JSON string', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('"just a string"');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/JSON object/i);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('shows error when input is malformed JSON', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('{not valid');
    await user.click(screen.getByRole('button', { name: /run/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/not valid JSON/i);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
