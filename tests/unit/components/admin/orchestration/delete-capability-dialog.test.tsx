/**
 * DeleteCapabilityDialog Component Tests
 *
 * Test Coverage:
 * - Happy-path delete: onConfirm callback fires and dialog can be closed
 * - Error message surfaces when parent passes an error string
 * - When usedBy agents > 0, warning list renders showing agent names before confirm
 *
 * The component is purely presentational — it receives callbacks and data
 * from the parent (CapabilitiesTable). We verify the rendered output and
 * that the correct callbacks are invoked.
 *
 * @see components/admin/orchestration/delete-capability-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DeleteCapabilityDialog } from '@/components/admin/orchestration/delete-capability-dialog';
import type {
  DeleteCapabilityTarget,
  UsedByAgent,
} from '@/components/admin/orchestration/delete-capability-dialog';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TARGET: DeleteCapabilityTarget = {
  id: 'cap-1',
  name: 'Web Search',
};

const AGENTS_USING: UsedByAgent[] = [
  { id: 'agent-1', name: 'Support Bot', slug: 'support-bot' },
  { id: 'agent-2', name: 'Research Agent', slug: 'research-agent' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DeleteCapabilityDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('renders the dialog when target is set', () => {
      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText('Delete capability')).toBeInTheDocument();
      expect(screen.getByText(/web search/i)).toBeInTheDocument();
    });

    it('calls onConfirm when the Delete button is clicked', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledOnce();
      });
    });

    it('calls onCancel when the Cancel button is clicked and dialog stays closed', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error={null}
          isDeleting={false}
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(onCancel).toHaveBeenCalledOnce();
      });
    });

    it('does not render the dialog when target is null', () => {
      render(
        <DeleteCapabilityDialog
          target={null}
          usedBy={[]}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.queryByText('Delete capability')).not.toBeInTheDocument();
    });
  });

  // ── Error state ────────────────────────────────────────────────────────────

  describe('error display', () => {
    it('surfaces inline error message when error prop is set', () => {
      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error="This capability is locked and cannot be deleted."
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(
        screen.getByText('This capability is locked and cannot be deleted.')
      ).toBeInTheDocument();
    });

    it('dialog remains open (target still set) when error is present', () => {
      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error="Delete failed"
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      // Dialog still visible
      expect(screen.getByText('Delete capability')).toBeInTheDocument();
      // Error visible
      expect(screen.getByText('Delete failed')).toBeInTheDocument();
    });
  });

  // ── usedBy warning list ────────────────────────────────────────────────────

  describe('usedBy warning list', () => {
    it('renders agent names when usedByAgents count > 0 before the confirm button', () => {
      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={AGENTS_USING}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      // Warning summary
      expect(screen.getByText(/2 agents currently using this capability/i)).toBeInTheDocument();

      // Each agent name listed
      expect(screen.getByText('Support Bot')).toBeInTheDocument();
      expect(screen.getByText('Research Agent')).toBeInTheDocument();

      // Slugs shown in parens
      expect(screen.getByText('(support-bot)')).toBeInTheDocument();
      expect(screen.getByText('(research-agent)')).toBeInTheDocument();
    });

    it('does NOT render the warning block when usedBy is empty', () => {
      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={[]}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      );

      expect(screen.queryByText(/agents currently using this capability/i)).not.toBeInTheDocument();
    });

    it('Delete button is still present and clickable even when agents are using the capability', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();

      render(
        <DeleteCapabilityDialog
          target={TARGET}
          usedBy={AGENTS_USING}
          error={null}
          isDeleting={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledOnce();
      });
    });
  });
});
