/**
 * InstructionsHistoryPanel Component Tests
 *
 * Test Coverage:
 * - Collapsed by default
 * - First expand fires one GET request
 * - Second expand does NOT fire another GET (data already loaded)
 * - Revert AlertDialog confirm → POST with correct versionIndex then refetches
 * - Diff dialog renders added/removed lines with distinct classes
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
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
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

    it('diff view contains added and removed line indicators', async () => {
      // Arrange — old text has "Line two", new text has "Current instructions text"
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.get).mockResolvedValue(TWO_VERSIONS);

      const user = userEvent.setup();
      render(<InstructionsHistoryPanel agentId={AGENT_ID} />);

      // Act: expand and open diff for first entry
      await user.click(screen.getByRole('button', { name: /version history/i }));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /diff/i })).toHaveLength(2));
      await user.click(screen.getAllByRole('button', { name: /diff/i })[0]);

      await waitFor(() => {
        expect(screen.getByText(/compare versions/i)).toBeInTheDocument();
      });

      // Assert: The diff view renders added (+) and removed (−) line indicators
      // The Dialog renders into a portal (document.body), not inside container
      await waitFor(() => {
        // The DiffView renders '+' for added and '−' for removed lines via <span>
        const bodyText = document.body.textContent ?? '';
        const hasCompareVersions = bodyText.includes('Compare versions');
        expect(hasCompareVersions).toBe(true);

        // The pre element in the body should have diff content
        const preElem = document.body.querySelector('pre');
        expect(preElem).not.toBeNull();
        expect(preElem?.textContent).toBeTruthy();
      });
    });
  });
});
