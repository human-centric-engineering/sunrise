/**
 * Unit Tests: PublishDialog
 *
 * Covers:
 *   - Renders only when `open` is true
 *   - Calls onConfirm with `undefined` when summary is empty
 *   - Calls onConfirm with the trimmed summary when filled
 *   - Disables Publish + shows error label when summary > 500 chars
 *   - Disables Publish while `publishing` is true and shows the spinner label
 *   - Calls onOpenChange(false) on Cancel
 *   - Renders the inline error message via role=alert when present
 *   - Resets the input when the dialog re-opens
 *
 * @see components/admin/orchestration/workflow-builder/publish-dialog.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublishDialog } from '@/components/admin/orchestration/workflow-builder/publish-dialog';

function renderDialog(overrides: Partial<Parameters<typeof PublishDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const props = {
    open: true,
    onOpenChange,
    onConfirm,
    publishing: false,
    errorMessage: null,
    nextVersion: 3,
    ...overrides,
  };
  const result = render(<PublishDialog {...props} />);
  return { ...result, onConfirm, onOpenChange };
}

describe('PublishDialog', () => {
  it('does not render dialog content when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the next-version hint in the description', () => {
    renderDialog({ nextVersion: 7 });
    expect(screen.getByText(/version 7/i)).toBeInTheDocument();
  });

  it('calls onConfirm with undefined when the summary is empty', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('calls onConfirm with the trimmed summary when filled', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const textarea = screen.getByLabelText(/change summary/i);
    await user.type(textarea, '  Tweaked the prompt  ');
    await user.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(onConfirm).toHaveBeenCalledWith('Tweaked the prompt');
  });

  it('disables Publish and shows an over-limit message when summary > 500 chars', async () => {
    const { onConfirm } = renderDialog();
    const textarea = screen.getByLabelText(/change summary/i);
    fireEvent.change(textarea, { target: { value: 'a'.repeat(501) } });
    expect(screen.getByText(/1 characters over/i)).toBeInTheDocument();
    const publishBtn = screen.getByRole('button', { name: /^publish$/i });
    expect(publishBtn).toBeDisabled();
    fireEvent.click(publishBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows the spinner label and disables Publish while publishing is true', () => {
    renderDialog({ publishing: true });
    const publishBtn = screen.getByRole('button', { name: /publishing/i });
    expect(publishBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders the inline error message with role=alert', () => {
    renderDialog({ errorMessage: 'Server exploded' });
    expect(screen.getByRole('alert')).toHaveTextContent('Server exploded');
  });

  it('resets the input when the dialog re-opens', async () => {
    const { onConfirm, rerender } = renderDialog();
    const user = userEvent.setup();
    const textarea = screen.getByLabelText(/change summary/i);
    await user.type(textarea, 'leftover text');

    // Close
    rerender(
      <PublishDialog open={false} onOpenChange={vi.fn()} onConfirm={onConfirm} nextVersion={3} />
    );
    // Re-open
    rerender(
      <PublishDialog open={true} onOpenChange={vi.fn()} onConfirm={onConfirm} nextVersion={3} />
    );

    // The previous text must have been cleared. queryByDisplayValue avoids the
    // type-cast dance with HTMLTextAreaElement and survives lint --fix passes.
    expect(screen.queryByDisplayValue('leftover text')).not.toBeInTheDocument();
  });
});
