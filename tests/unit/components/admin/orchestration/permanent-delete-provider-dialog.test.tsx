/**
 * PermanentDeleteProviderDialog Component Tests
 *
 * Test Coverage:
 * - Closed state: nothing rendered when target is null.
 * - Open state: title, description (provider name + slug), error,
 *   confirm + cancel button behaviour, in-flight disable.
 * - Confirm uses preventDefault to keep the dialog open while the
 *   async hard-delete is in flight.
 *
 * @see components/admin/orchestration/permanent-delete-provider-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  PermanentDeleteProviderDialog,
  type PermanentDeleteTarget,
} from '@/components/admin/orchestration/permanent-delete-provider-dialog';

const TARGET: PermanentDeleteTarget = {
  id: 'prov-cuid-anthropic',
  name: 'Anthropic',
  slug: 'anthropic',
};

describe('PermanentDeleteProviderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when target is null', () => {
    it('does not render the dialog title', () => {
      render(
        <PermanentDeleteProviderDialog
          target={null}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.queryByText('Delete permanently')).not.toBeInTheDocument();
    });
  });

  describe('when target is set', () => {
    it('renders the alert dialog with the destructive title', () => {
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      // The phrase "Delete permanently" appears twice (title + action
      // button) — scope the assertion to the dialog title via its role.
      expect(screen.getByRole('heading', { name: /delete permanently/i })).toBeInTheDocument();
    });

    it('shows the provider name and slug in the description', () => {
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      // Name is rendered in <strong>, slug in <span class="font-mono">.
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('anthropic')).toBeInTheDocument();
    });

    it('warns about the agent + cost-log foreign-key check', () => {
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
      expect(screen.getByText(/agent.*cost-log/i)).toBeInTheDocument();
    });

    it('renders an inline error block when the error prop is set', () => {
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error="2 agents reference this provider — re-point them first"
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(
        screen.getByText(/2 agents reference this provider — re-point them first/i)
      ).toBeInTheDocument();
    });

    it('calls onConfirm when the destructive action is clicked', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete permanently/i }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('keeps the dialog mounted after confirm so the async delete can settle', async () => {
      // The component calls e.preventDefault() on the action button so
      // Radix doesn't auto-close the dialog while the network call is
      // in flight. Asserted here by checking the dialog is still
      // present after the click.
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete permanently/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('disables the confirm button and labels it "Deleting…" while isDeleting=true', () => {
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={true}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      const btn = screen.getByRole('button', { name: /deleting/i });
      expect(btn).toBeDisabled();
    });

    it('calls onCancel when the cancel button is clicked', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();
      render(
        <PermanentDeleteProviderDialog
          target={TARGET}
          error={null}
          isDeleting={false}
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
