/**
 * Unit Tests: WorkflowDetailsDialog
 *
 * Test Coverage:
 * - Opens with workflowName pre-filling slug via slugify
 * - Editing slug stops auto-derivation from workflowName
 * - Invalid slug (uppercase) renders validation error and disables Confirm
 * - Confirm fires onConfirm with { slug, description, errorStrategy, isTemplate }
 * - Cancel calls onOpenChange(false)
 *
 * @see components/admin/orchestration/workflow-builder/workflow-details-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowDetailsDialog } from '@/components/admin/orchestration/workflow-builder/workflow-details-dialog';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowDetailsDialog', () => {
  const defaultProps = {
    open: true,
    workflowName: 'My Workflow',
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog when open=true', () => {
    render(<WorkflowDetailsDialog {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not render the dialog when open=false', () => {
    render(<WorkflowDetailsDialog {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pre-fills the slug from workflowName via slugify', () => {
    render(<WorkflowDetailsDialog {...defaultProps} workflowName="My Workflow" />);
    expect(screen.getByRole('textbox', { name: /slug/i })).toHaveValue('my-workflow');
  });

  it('slugifies names with special characters', () => {
    render(<WorkflowDetailsDialog {...defaultProps} workflowName="Hello World! 123" />);
    expect(screen.getByRole('textbox', { name: /slug/i })).toHaveValue('hello-world-123');
  });

  it('stops auto-deriving slug once user edits the slug field', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WorkflowDetailsDialog {...defaultProps} workflowName="My Workflow" />
    );

    const slugInput = screen.getByRole('textbox', { name: /slug/i });

    // User manually sets slug to something custom
    await user.clear(slugInput);
    await user.type(slugInput, 'custom-slug');

    // Change the workflow name — slug should NOT update anymore
    rerender(<WorkflowDetailsDialog {...defaultProps} workflowName="Completely Different Name" />);

    expect(screen.getByRole('textbox', { name: /slug/i })).toHaveValue('custom-slug');
  });

  it('shows a validation error and disables Confirm when slug contains uppercase', async () => {
    const user = userEvent.setup();
    render(<WorkflowDetailsDialog {...defaultProps} />);

    const slugInput = screen.getByRole('textbox', { name: /slug/i });
    await user.clear(slugInput);
    await user.type(slugInput, 'Invalid-Slug');

    // Should show error message
    expect(screen.getByText(/lowercase alphanumeric with hyphens/i)).toBeInTheDocument();

    // Fill description so that would be valid
    const descInput = screen.getByRole('textbox', { name: /description/i });
    await user.type(descInput, 'Some description');

    // Confirm button should be disabled
    const confirmBtn = screen.getByRole('button', { name: /save workflow/i });
    expect(confirmBtn).toBeDisabled();
  });

  it('disables Confirm when description is empty', () => {
    render(<WorkflowDetailsDialog {...defaultProps} />);
    const confirmBtn = screen.getByRole('button', { name: /save workflow/i });
    // Initially description is empty so Confirm should be disabled
    expect(confirmBtn).toBeDisabled();
  });

  it('fires onConfirm with correct data when slug and description are valid', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

    const descInput = screen.getByRole('textbox', { name: /description/i });
    await user.type(descInput, 'A test workflow description');

    const confirmBtn = screen.getByRole('button', { name: /save workflow/i });
    await user.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [details] = onConfirm.mock.calls[0];
    expect(details.slug).toBe('my-workflow');
    expect(details.description).toBe('A test workflow description');
    expect(details.errorStrategy).toBe('fail');
    expect(typeof details.isTemplate).toBe('boolean');
  });

  it('fires onConfirm with correct isTemplate when checkbox is checked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

    // Check the template checkbox
    const checkbox = screen.getByRole('checkbox', { name: /save as template/i });
    await user.click(checkbox);

    // Fill description
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');

    await user.click(screen.getByRole('button', { name: /save workflow/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].isTemplate).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<WorkflowDetailsDialog {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('pre-fills from initial prop when provided', () => {
    render(
      <WorkflowDetailsDialog
        {...defaultProps}
        initial={{
          slug: 'existing-slug',
          description: 'Existing desc',
          errorStrategy: 'retry',
          isTemplate: true,
        }}
      />
    );

    // Arrange: all four initial fields should be reflected in the UI
    expect(screen.getByRole('textbox', { name: /slug/i })).toHaveValue('existing-slug');
    expect(screen.getByRole('textbox', { name: /description/i })).toHaveValue('Existing desc');
    // errorStrategy: the Select trigger should display the label for 'retry'
    expect(screen.getByRole('combobox', { name: /error strategy/i })).toHaveTextContent(
      'Retry step'
    );
    // isTemplate: the checkbox should be checked
    expect(screen.getByRole('checkbox', { name: /save as template/i })).toBeChecked();
  });

  it('shows a validation error and disables Confirm when slug is cleared', async () => {
    const user = userEvent.setup();
    render(<WorkflowDetailsDialog {...defaultProps} />);

    const slugInput = screen.getByRole('textbox', { name: /slug/i });

    // Arrange: fill description so only slug is the blocking issue
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'Some description');

    // Act: clear the slug — empty string fails SLUG_REGEX
    await user.clear(slugInput);

    // Assert: validation error is visible and confirm button is disabled
    expect(screen.getByText(/lowercase alphanumeric with hyphens/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save workflow/i })).toBeDisabled();
  });

  it('does not call onConfirm when form is invalid and confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

    // Arrange: leave description empty (canConfirm = false) and clear the auto-derived slug
    const slugInput = screen.getByRole('textbox', { name: /slug/i });
    await user.clear(slugInput);

    // Act: attempt to click the disabled confirm button
    const confirmBtn = screen.getByRole('button', { name: /save workflow/i });
    expect(confirmBtn).toBeDisabled();
    // userEvent respects the disabled attribute — the click is a no-op
    await user.click(confirmBtn);

    // Assert: onConfirm must never have been invoked
    expect(onConfirm).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  // ── Per-execution cap input ──────────────────────────────────────────────────

  describe('per-execution cost cap', () => {
    it('pre-fills the cap input from initial.maxCostPerExecutionUsd when provided', () => {
      render(<WorkflowDetailsDialog {...defaultProps} initial={{ maxCostPerExecutionUsd: 2.5 }} />);
      expect(screen.getByRole('spinbutton', { name: /per-execution cost cap/i })).toHaveValue(2.5);
    });

    it('leaves the cap input blank when initial.maxCostPerExecutionUsd is undefined', () => {
      // Default props don't include initial — cap should start empty.
      render(<WorkflowDetailsDialog {...defaultProps} />);
      expect(screen.getByRole('spinbutton', { name: /per-execution cost cap/i })).toHaveValue(null);
    });

    it('passes maxCostPerExecutionUsd: null when the cap input is left blank', async () => {
      const user = userEvent.setup();
      const onConfirm = vi.fn();
      render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

      await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');
      await user.click(screen.getByRole('button', { name: /save workflow/i }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm.mock.calls[0][0].maxCostPerExecutionUsd).toBeNull();
    });

    it('passes the parsed numeric cap to onConfirm when a valid value is entered', async () => {
      const user = userEvent.setup();
      const onConfirm = vi.fn();
      render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

      await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');
      await user.type(screen.getByRole('spinbutton', { name: /per-execution cost cap/i }), '1.50');
      await user.click(screen.getByRole('button', { name: /save workflow/i }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm.mock.calls[0][0].maxCostPerExecutionUsd).toBe(1.5);
    });

    it('shows the validation error and disables Confirm when the cap is below $0.01', async () => {
      const user = userEvent.setup();
      render(<WorkflowDetailsDialog {...defaultProps} />);

      // Description must be valid so the cap is the only blocker.
      await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');
      // Typing "0" parses to 0, which fails the >=0.01 guard.
      await user.type(screen.getByRole('spinbutton', { name: /per-execution cost cap/i }), '0');

      expect(screen.getByText(/positive number between \$0\.01 and \$10,000/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save workflow/i })).toBeDisabled();
    });

    it('shows the validation error when the cap exceeds $10,000', async () => {
      const user = userEvent.setup();
      render(<WorkflowDetailsDialog {...defaultProps} />);

      await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');
      await user.type(screen.getByRole('spinbutton', { name: /per-execution cost cap/i }), '99999');

      expect(screen.getByText(/positive number between \$0\.01 and \$10,000/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save workflow/i })).toBeDisabled();
    });
  });

  // ── Description character counter ────────────────────────────────────────────

  it('renders the description character counter and updates as the user types', async () => {
    // The counter copy "0/5,000" is rendered on first paint and the colour
    // class flips destructive once over 5,000 — but the input is capped at
    // maxLength=5000 so we only need to assert the counter updates.
    const user = userEvent.setup();
    render(<WorkflowDetailsDialog {...defaultProps} />);
    expect(screen.getByText('0/5,000')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'Hello');
    expect(screen.getByText('5/5,000')).toBeInTheDocument();
  });

  // ── Error strategy selector ──────────────────────────────────────────────────

  it('passes the selected errorStrategy through to onConfirm when changed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<WorkflowDetailsDialog {...defaultProps} onConfirm={onConfirm} />);

    // Fill description so the form is otherwise valid.
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'A workflow');

    // Open the Select and pick "Skip step".
    await user.click(screen.getByRole('combobox', { name: /error strategy/i }));
    await user.click(screen.getByRole('option', { name: /skip step/i }));

    await user.click(screen.getByRole('button', { name: /save workflow/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].errorStrategy).toBe('skip');
  });
});
