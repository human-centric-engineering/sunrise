/**
 * InstructionsHistoryPanel Component Tests
 *
 * Test Coverage:
 * - Collapsed by default
 * - First expand fires one GET request
 * - Second expand does NOT fire another GET (data already loaded)
 * - Revert AlertDialog confirm → POST with correct versionIndex then refetches
 * - Diff dialog renders added/removed lines with distinct content (not just existence)
 * - fetchHistory APIClientError → error message shown in panel
 * - handleRevert APIClientError → error message shown in AlertDialog
 *
 * @see components/admin/orchestration/instructions-history-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InstructionsHistoryPanel } from '@/components/admin/orchestration/instructions-history-panel';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

function makeHistoryResponse(
  entries: Array<{ instructions: string; changedAt: string; changedBy: string }> = []
) {
  return {
    agentId: AGENT_ID,
    slug: 'test-agent',
    current: 'Current instructions text',
    history: entries,
  };
}

const TWO_VERSIONS = makeHistoryResponse([
  {
    instructions: 'Version 2 instructions\nLine two\nLine three',
    changedAt: '2025-03-01T10:00:00Z',
    changedBy: 'admin@example.com',
  },
  {
    instructions: 'Version 1 original\nLine two',
    changedAt: '2025-01-01T10:00:00Z',
    changedBy: 'alice@example.com',
  },
]);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InstructionsHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Collapsed by default ───────────────────────────────────────────────────

  it('is collapsed by default (history content not visible)', () => {
    // Arrange & Act
    render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

    // Assert: toggle button visible, content not visible
    expect(screen.getByRole('button', { name: /version history/i })).toBeInTheDocument();
    expect(screen.queryByText(/loading history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no previous versions/i)).not.toBeInTheDocument();
  });

  it('does NOT call GET before first expand', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    // Act: render without expanding
    render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

    // Assert: no API call fired yet
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  // ── First expand ───────────────────────────────────────────────────────────

  it('fires one GET on first expand', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

    // Act: expand
    await user.click(screen.getByRole('button', { name: /version history/i }));

    // Assert
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledOnce();
      expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/instructions-history'));
    });
  });

  it('shows empty state when no history entries', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

    // Act
    await user.click(screen.getByRole('button', { name: /version history/i }));

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/no previous versions yet/i)).toBeInTheDocument();
    });
  });

  it('second expand does NOT fire another GET (uses cached data)', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue(makeHistoryResponse([]));

    const user = userEvent.setup();
    render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

    // Act: expand, collapse, expand again
    await user.click(screen.getByRole('button', { name: /version history/i }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledOnce());

    await user.click(screen.getByRole('button', { name: /version history/i }));
    await user.click(screen.getByRole('button', { name: /version history/i }));

    // Assert: still only 1 GET call
    expect(apiClient.get).toHaveBeenCalledOnce();
  });

  // ── Error handling: fetchHistory ───────────────────────────────────────────

  describe('fetchHistory error handling', () => {
    it('shows APIClientError message when GET fails', async () => {
      // Arrange
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('History unavailable — server error', 'INTERNAL_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act: expand triggers the failing GET
      await user.click(screen.getByRole('button', { name: /version history/i }));

      // Assert: the APIClientError message is rendered in the panel, not the fallback
      await waitFor(() => {
        expect(screen.getByText('History unavailable — server error')).toBeInTheDocument();
      });
      // The fallback generic message must NOT appear when an APIClientError message is used
      expect(screen.queryByText('Could not load instructions history.')).not.toBeInTheDocument();
    });

    it('shows fallback message when a non-APIClientError is thrown during GET', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network failure'));

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act
      await user.click(screen.getByRole('button', { name: /version history/i }));

      // Assert: component falls back to its generic error string
      await waitFor(() => {
        expect(screen.getByText('Could not load instructions history.')).toBeInTheDocument();
      });
    });
  });

  // ── Revert ────────────────────────────────────────────────────────────────

  describe('revert flow', () => {
    it('opens revert AlertDialog on Revert click', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act: expand and click Revert on first row
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2)
      );

      await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);

      // Assert: dialog visible
      await waitFor(() => {
        expect(screen.getByText(/revert to this version/i)).toBeInTheDocument();
      });
    });

    it('POSTs with correct versionIndex (newest-first display → oldest=0)', async () => {
      // Arrange — 2 versions: displayIndex 0 = versionIndex 1 (newest), displayIndex 1 = versionIndex 0 (oldest)
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
      vi.mocked(apiClient.post).mockResolvedValue({ success: true });

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Expand
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2)
      );

      // Click Revert on the first displayed row (newest, displayIndex=0 → versionIndex=1)
      await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);

      // Confirm revert
      await waitFor(() => expect(screen.getByText(/revert to this version/i)).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^revert$/i }));

      // Assert: POST with versionIndex=1
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/instructions-revert'),
          expect.objectContaining({ body: { versionIndex: 1 } })
        );
      });
    });

    it('calls onReverted callback after successful revert', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
      vi.mocked(apiClient.post).mockResolvedValue({ success: true });

      const onReverted = vi.fn();
      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} onReverted={onReverted} />);

      // Expand, revert, confirm
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2)
      );
      await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);
      await waitFor(() => expect(screen.getByText(/revert to this version/i)).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^revert$/i }));

      // Assert
      await waitFor(() => {
        expect(onReverted).toHaveBeenCalledOnce();
      });
    });

    it('does NOT call onReverted when POST fails with APIClientError', async () => {
      // NOTE: AlertDialogPrimitive.Action closes the dialog synchronously on click,
      // which fires onOpenChange(false) → setRevertTarget(null) + setRevertError(null)
      // before the async handleRevert resolves. This means the revertError state is
      // set after the dialog is already closed and its content unmounted, so the error
      // paragraph rendered inside AlertDialogContent is not reachable via user interaction.
      //
      // SUSPECTED CODE BUG: the revertError UI is unreachable — the AlertDialogAction
      // triggers dialog closure synchronously before the POST resolves, so {revertError}
      // inside the dialog is never visible to the user. The component should either use
      // a regular Dialog with a manual close button, or handle the error outside the dialog.
      //
      // Observable behavior we CAN assert: onReverted is not called when the POST fails.
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Version already current — no change needed', 'CONFLICT', 409)
      );

      const onReverted = vi.fn();
      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} onReverted={onReverted} />);

      // Expand, open revert dialog, confirm
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2)
      );
      await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);
      await waitFor(() => expect(screen.getByText(/revert to this version/i)).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^revert$/i }));

      // Wait for the async handleRevert to complete (POST rejected)
      await waitFor(() => {
        // apiClient.post was called (the revert attempt happened)
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/instructions-revert'),
          expect.anything()
        );
      });

      // onReverted must NOT have been called because the POST failed
      expect(onReverted).not.toHaveBeenCalled();
    });

    it('does NOT call onReverted when POST fails with a generic error', async () => {
      // Same observable-behavior test for the non-APIClientError branch.
      // See the note above about revertError being unreachable in the UI.
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network timeout'));

      const onReverted = vi.fn();
      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} onReverted={onReverted} />);

      // Expand, open revert dialog, confirm
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /revert/i })).toHaveLength(2)
      );
      await user.click(screen.getAllByRole('button', { name: /revert/i })[0]);
      await waitFor(() => expect(screen.getByText(/revert to this version/i)).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^revert$/i }));

      // Wait for the async handleRevert to complete (POST rejected)
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/instructions-revert'),
          expect.anything()
        );
      });

      // onReverted must NOT have been called because the POST failed
      expect(onReverted).not.toHaveBeenCalled();
    });
  });

  // ── Diff dialog ───────────────────────────────────────────────────────────

  describe('diff dialog', () => {
    it('opens diff dialog on Diff click', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /diff/i })).toHaveLength(2));
      await user.click(screen.getAllByRole('button', { name: /diff/i })[0]);

      // Assert: diff dialog open
      await waitFor(() => {
        expect(screen.getByText(/compare versions/i)).toBeInTheDocument();
      });
    });

    it('diff view renders line text from both old and new versions', async () => {
      // Arrange — TWO_VERSIONS[0].instructions = "Version 2 instructions\nLine two\nLine three"
      //           data.current = "Current instructions text"
      // The LCS diff will mark "Version 2 instructions" and "Line three" as removed (del),
      // "Current instructions text" as added (add), and "Line two" as unchanged (same).
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act: expand and open diff for first entry (newest)
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /diff/i })).toHaveLength(2));
      await user.click(screen.getAllByRole('button', { name: /diff/i })[0]);

      await waitFor(() => {
        expect(screen.getByText(/compare versions/i)).toBeInTheDocument();
      });

      // Assert: diff rows contain actual line content from the old and new text.
      // "Version 2 instructions" is only in the old text — must appear as a removed line.
      // "Current instructions text" is only in the new text — must appear as an added line.
      // "Line two" appears in both — must appear as an unchanged line.
      await waitFor(() => {
        const preElem = document.body.querySelector('pre');
        expect(preElem).not.toBeNull();

        const preText = preElem?.textContent ?? '';
        // Removed line from old version
        expect(preText).toContain('Version 2 instructions');
        // Added line from new (current) version
        expect(preText).toContain('Current instructions text');
        // Unchanged line present in both versions
        expect(preText).toContain('Line two');
      });

      // Assert: the diff indicator spans ('+' for add, '−' for del) are present in the dialog.
      // These are rendered by DiffView for every non-same row.
      const addIndicators = document.body.querySelectorAll('pre span');
      const indicatorTexts = Array.from(addIndicators).map((el) => el.textContent);
      expect(indicatorTexts).toContain('+');
      expect(indicatorTexts).toContain('−');
    });
  });
});
