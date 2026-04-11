/**
 * Unit Tests: ValidationSummaryPanel
 *
 * Test Coverage:
 * - Empty errors → shows "No issues" green message
 * - Mixed WorkflowValidationError + ExtraCheckError entries render
 * - Clicking an error row with stepId calls onFocusNode(stepId)
 * - Errors without a stepId render a disabled button
 * - role="status" and aria-live="polite" are present
 *
 * @see components/admin/orchestration/workflow-builder/validation-summary-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ValidationSummaryPanel } from '@/components/admin/orchestration/workflow-builder/validation-summary-panel';
import type { CombinedError } from '@/components/admin/orchestration/workflow-builder/validation-summary-panel';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CORE_ERROR: CombinedError = {
  code: 'MISSING_ENTRY',
  message: 'No entry step defined',
};

const EXTRA_ERROR_WITH_STEP: CombinedError = {
  code: 'MISSING_REQUIRED_CONFIG',
  message: 'LLM Call "My Step" needs a prompt template',
  stepId: 'step-1',
};

const EXTRA_ERROR_NO_STEP: CombinedError = {
  code: 'DISCONNECTED_NODE',
  message: 'An orphan node has no stepId somehow',
  // no stepId
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ValidationSummaryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has role="status" and aria-live="polite"', () => {
    render(<ValidationSummaryPanel errors={[]} onFocusNode={vi.fn()} />);
    const panel = screen.getByRole('status');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('aria-live', 'polite');
  });

  describe('empty errors', () => {
    it('shows "No issues" message when there are no errors', () => {
      render(<ValidationSummaryPanel errors={[]} onFocusNode={vi.fn()} />);
      expect(screen.getByText(/no issues/i)).toBeInTheDocument();
    });

    it('does NOT show an error list when errors is empty', () => {
      render(<ValidationSummaryPanel errors={[]} onFocusNode={vi.fn()} />);
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });
  });

  describe('with errors', () => {
    it('shows the count of errors', () => {
      const errors: CombinedError[] = [CORE_ERROR, EXTRA_ERROR_WITH_STEP];
      render(<ValidationSummaryPanel errors={errors} onFocusNode={vi.fn()} />);
      expect(screen.getByText(/2 issues found/i)).toBeInTheDocument();
    });

    it('shows singular "1 issue found" for a single error', () => {
      render(<ValidationSummaryPanel errors={[CORE_ERROR]} onFocusNode={vi.fn()} />);
      expect(screen.getByText(/1 issue found/i)).toBeInTheDocument();
    });

    it('renders the error message text', () => {
      render(<ValidationSummaryPanel errors={[CORE_ERROR]} onFocusNode={vi.fn()} />);
      expect(screen.getByText(/no entry step defined/i)).toBeInTheDocument();
    });

    it('renders a human-readable code label for known codes', () => {
      render(<ValidationSummaryPanel errors={[EXTRA_ERROR_WITH_STEP]} onFocusNode={vi.fn()} />);
      expect(screen.getByText(/missing required configuration/i)).toBeInTheDocument();
    });

    it('calls onFocusNode with stepId when an error row with stepId is clicked', async () => {
      const user = userEvent.setup();
      const onFocusNode = vi.fn();
      render(<ValidationSummaryPanel errors={[EXTRA_ERROR_WITH_STEP]} onFocusNode={onFocusNode} />);

      // Find the button for this error and click it
      const errorButtons = screen.getAllByRole('button');
      // Find the one with the error message text
      const errorBtn = errorButtons.find((btn) =>
        btn.textContent?.includes('LLM Call "My Step" needs a prompt template')
      );
      expect(errorBtn).toBeDefined();
      await user.click(errorBtn!);

      expect(onFocusNode).toHaveBeenCalledWith('step-1');
    });

    it('renders a disabled button for errors without a stepId', () => {
      render(<ValidationSummaryPanel errors={[EXTRA_ERROR_NO_STEP]} onFocusNode={vi.fn()} />);

      // The button for this error should be disabled
      const errorButtons = screen.getAllByRole('button');
      const disabledBtn = errorButtons.find(
        (btn) => btn.hasAttribute('disabled') && btn.textContent?.includes('An orphan node')
      );
      expect(disabledBtn).toBeDefined();
    });

    it('does NOT call onFocusNode when clicking an error with no stepId', async () => {
      const user = userEvent.setup();
      const onFocusNode = vi.fn();
      render(<ValidationSummaryPanel errors={[EXTRA_ERROR_NO_STEP]} onFocusNode={onFocusNode} />);

      const errorButtons = screen.getAllByRole('button');
      const errorBtn = errorButtons.find((btn) => btn.textContent?.includes('An orphan node'));
      // The button is disabled so clicking it shouldn't fire the handler
      if (errorBtn) {
        await user.click(errorBtn);
      }

      expect(onFocusNode).not.toHaveBeenCalled();
    });

    it('renders both WorkflowValidationError and ExtraCheckError entries', () => {
      render(
        <ValidationSummaryPanel
          errors={[CORE_ERROR, EXTRA_ERROR_WITH_STEP]}
          onFocusNode={vi.fn()}
        />
      );

      expect(screen.getByText(/no entry step defined/i)).toBeInTheDocument();
      expect(screen.getByText(/needs a prompt template/i)).toBeInTheDocument();
    });
  });
});
