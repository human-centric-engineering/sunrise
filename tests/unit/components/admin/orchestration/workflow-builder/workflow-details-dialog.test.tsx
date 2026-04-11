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
    expect(onConfirm.mock.calls[0][0].isTemplate).toBe(true);
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

    expect(screen.getByRole('textbox', { name: /slug/i })).toHaveValue('existing-slug');
    expect(screen.getByRole('textbox', { name: /description/i })).toHaveValue('Existing desc');
  });
});
