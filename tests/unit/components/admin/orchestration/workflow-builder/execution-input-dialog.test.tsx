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
 *   - Dry-run: valid input → shows dry-run result (valid=true)
 *   - Dry-run: valid input + API returns invalid result → shows dry-run failed
 *   - Dry-run: API error → shows error message
 *   - Dry-run: invalid JSON → returns early, no API call
 *   - Dry-run loading state: button shows "Validating…" while in-flight
 *   - Dry-run result: dryRunResult.errors list rendered
 *   - Dry-run result: dryRunResult.warnings list rendered
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionInputDialog,
  type ExecutionInputDialogProps,
} from '@/components/admin/orchestration/workflow-builder/execution-input-dialog';

// ─── apiClient mock ──────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient } from '@/lib/api/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderDialog(overrides: Partial<ExecutionInputDialogProps> = {}) {
  const props: ExecutionInputDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    workflowId: 'wf-test-123',
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onConfirm with parsed inputData for valid JSON object', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('{"key": "value"}');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

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
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ budgetLimitUsd: 0.5 }));
  });

  it('omits budgetLimitUsd when budget field is empty', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    // Default textarea has valid JSON, budget is empty by default
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    const call = (props.onConfirm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.budgetLimitUsd).toBeUndefined();
  });

  it('shows error for zero budget and does not call onConfirm', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setBudgetValue('0');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/positive number/i);
    expect(props.onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error for negative budget and does not call onConfirm', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setBudgetValue('-5');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/positive number/i);
    expect(props.onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error when input is a JSON array', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('[1,2,3]');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/JSON object/i);
    expect(props.onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error when input is a JSON string', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('"just a string"');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/JSON object/i);
    expect(props.onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error when input is malformed JSON', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    setTextarea('{not valid');
    await user.click(screen.getByRole('button', { name: /^run$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/not valid JSON/i);
    expect(props.onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('dry-run', () => {
    it('shows "Dry run passed" when API returns valid=true', async () => {
      // Arrange: API resolves with a passing dry-run result
      vi.mocked(apiClient.post).mockResolvedValue({ valid: true });
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-1' });

      // Act: default textarea has valid JSON, click "Dry run"
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: the success result card appears
      await waitFor(() => {
        expect(screen.getByText(/dry run passed/i)).toBeInTheDocument();
      });
    });

    it('shows "Dry run failed" when API returns valid=false', async () => {
      // Arrange: API resolves with a failing dry-run result
      vi.mocked(apiClient.post).mockResolvedValue({
        valid: false,
        errors: ['Step "entry" is missing required field'],
      });
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-2' });

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: failure card and error list rendered
      await waitFor(() => {
        expect(screen.getByText(/dry run failed/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/missing required field/i)).toBeInTheDocument();
    });

    it('renders dryRunResult.errors as a list when present', async () => {
      // Arrange
      vi.mocked(apiClient.post).mockResolvedValue({
        valid: false,
        errors: ['Error alpha', 'Error beta'],
      });
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-errs' });

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: both error messages appear in the list
      await waitFor(() => {
        expect(screen.getByText('Error alpha')).toBeInTheDocument();
      });
      expect(screen.getByText('Error beta')).toBeInTheDocument();
    });

    it('renders dryRunResult.warnings as a list when present', async () => {
      // Arrange
      vi.mocked(apiClient.post).mockResolvedValue({
        valid: true,
        warnings: ['Warn one', 'Warn two'],
      });
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-warns' });

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: both warnings appear
      await waitFor(() => {
        expect(screen.getByText('Warn one')).toBeInTheDocument();
      });
      expect(screen.getByText('Warn two')).toBeInTheDocument();
    });

    it('shows "Dry-run request failed." when API throws', async () => {
      // Arrange: API call rejects
      vi.mocked(apiClient.post).mockRejectedValue(new Error('network error'));
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-err' });

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: error alert appears
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/dry-run request failed/i);
      });
    });

    it('does not call apiClient.post when input JSON is invalid', async () => {
      // Arrange: invalid JSON in textarea
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-invalid' });
      setTextarea('{bad json');

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: parse error shown, no API call made
      expect(screen.getByRole('alert')).toHaveTextContent(/not valid JSON/i);
      expect(apiClient.post).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('shows "Validating…" label while dry-run is in-flight', async () => {
      // Arrange: never-resolving promise so we can observe loading state
      vi.mocked(apiClient.post).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderDialog({ workflowId: 'wf-dry-loading' });

      // Act
      await user.click(screen.getByRole('button', { name: /dry run/i }));

      // Assert: loading text visible
      expect(screen.getByText(/validating/i)).toBeInTheDocument();
    });
  });
});
