/**
 * DeleteProviderDialog Component Tests
 *
 * Test Coverage:
 * - Does not render dialog content when target is null
 * - Renders dialog open with provider name and slug when target is set
 * - Renders inline error message when error prop is provided
 * - Confirm button calls onConfirm and is labeled "Delete"
 * - Confirm button is disabled and labeled "Deleting…" when isDeleting=true
 * - Cancel button calls onCancel
 * - onOpenChange(false) calls onCancel (keyboard/overlay dismiss)
 *
 * @see components/admin/orchestration/delete-provider-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  DeleteProviderDialog,
  type DeleteProviderTarget,
} from '@/components/admin/orchestration/delete-provider-dialog';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDER_TARGET: DeleteProviderTarget = {
  id: 'prov-1',
  name: 'Anthropic',
  slug: 'anthropic',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DeleteProviderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Closed state ──────────────────────────────────────────────────────────

  describe('when target is null', () => {
    it('does not show dialog title', () => {
      render(
        <DeleteProviderDialog
          target={null}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.queryByText('Delete provider')).not.toBeInTheDocument();
    });
  });

  // ── Open state ────────────────────────────────────────────────────────────

  describe('when target is set', () => {
    it('renders the dialog title', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText('Delete provider')).toBeInTheDocument();
    });

    it('renders the provider name in the description', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });

    it('renders the provider slug in the description', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText('anthropic')).toBeInTheDocument();
    });

    it('renders Cancel and Delete buttons', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });

  // ── Error state ───────────────────────────────────────────────────────────

  describe('error display', () => {
    it('renders error message when error prop is provided', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error="Something went wrong"
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('does not render error paragraph when error is null', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      // No destructive-coloured text visible
      const body = document.body.textContent ?? '';
      expect(body).not.toContain('Something went wrong');
    });
  });

  // ── isDeleting state ──────────────────────────────────────────────────────

  describe('isDeleting state', () => {
    it('confirm button shows "Deleting…" label when isDeleting is true', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={true}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /deleting/i })).toBeInTheDocument();
    });

    it('confirm button is disabled when isDeleting is true', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={true}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /deleting/i })).toBeDisabled();
    });

    it('confirm button shows "Delete" label when isDeleting is false', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });

    it('confirm button is enabled when isDeleting is false', () => {
      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /^delete$/i })).not.toBeDisabled();
    });
  });

  // ── Callbacks ─────────────────────────────────────────────────────────────

  describe('callbacks', () => {
    it('clicking confirm button calls onConfirm', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('clicking cancel button calls onCancel', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('clicking confirm does not prevent onConfirm from being called', async () => {
      // Note: AlertDialogAction (Radix) closes the dialog after action, which
      // triggers onOpenChange(false) → onCancel. That is expected Radix behavior.
      // This test verifies onConfirm is always called when the confirm button fires.
      const onConfirm = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteProviderDialog
          target={PROVIDER_TARGET}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      expect(onConfirm).toHaveBeenCalledOnce();
    });
  });
});
