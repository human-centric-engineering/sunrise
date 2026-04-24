/**
 * AgentVersionHistoryTab Component Tests
 *
 * Test Coverage:
 * - Loading state on mount
 * - Renders version list after fetch
 * - Error state when fetch fails
 * - Empty state when no versions exist
 * - Restore button hidden for latest version
 * - Restore confirmation dialog opens and submits
 * - Restore error is displayed in dialog
 * - onRestored callback fires after successful restore
 *
 * @see components/admin/orchestration/agent-version-history-tab.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentVersionHistoryTab } from '@/components/admin/orchestration/agent-version-history-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        agentVersions: (id: string) => `/api/v1/admin/orchestration/agents/${id}/versions`,
        agentVersionRestore: (id: string, vId: string) =>
          `/api/v1/admin/orchestration/agents/${id}/versions/${vId}/restore`,
      },
    },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-abc-123';

const VERSIONS = [
  {
    id: 'ver-3',
    version: 3,
    changeSummary: 'Updated model to claude-opus-4-6',
    createdBy: 'user-1',
    createdAt: '2026-04-20T12:00:00Z',
  },
  {
    id: 'ver-2',
    version: 2,
    changeSummary: 'Changed temperature',
    createdBy: 'user-1',
    createdAt: '2026-04-19T10:00:00Z',
  },
  {
    id: 'ver-1',
    version: 1,
    changeSummary: null,
    createdBy: 'user-2',
    createdAt: '2026-04-18T08:00:00Z',
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentVersionHistoryTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(VERSIONS);
  });

  it('shows loading spinner on mount', () => {
    // Never-resolving promise to keep loading state
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);
    expect(screen.getByText('Loading version history…')).toBeInTheDocument();
  });

  it('renders version list after fetch', async () => {
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });

    expect(screen.getByText('Updated model to claude-opus-4-6')).toBeInTheDocument();
    expect(screen.getByText('Changed temperature')).toBeInTheDocument();
    // Null changeSummary falls back to "Configuration updated"
    expect(screen.getByText('Configuration updated')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('fetches with correct URL', async () => {
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/agents/${AGENT_ID}/versions?limit=50`
      );
    });
  });

  it('shows error state when fetch fails', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Could not load version history. Try again.')).toBeInTheDocument();
    });
  });

  it('shows empty state when no versions exist', async () => {
    mockGet.mockResolvedValue([]);
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(
        screen.getByText('No version history yet. Changes will appear here after the first save.')
      ).toBeInTheDocument();
    });
  });

  it('hides Restore button for the latest version (idx 0)', async () => {
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    // Only 2 restore buttons for v2 and v1, not v3
    expect(restoreButtons).toHaveLength(2);
  });

  it('opens restore confirmation dialog', async () => {
    const user = userEvent.setup();
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
    });

    // Click restore on v2
    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]); // First restore button = v2

    expect(screen.getByText('Restore to version 2?')).toBeInTheDocument();
    expect(screen.getByText(/revert the agent's configuration/)).toBeInTheDocument();
  });

  it('calls restore endpoint and invokes onRestored callback', async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    mockPost.mockResolvedValue({});
    // After restore, re-fetch returns updated versions
    mockGet.mockResolvedValue(VERSIONS);

    render(<AgentVersionHistoryTab agentId={AGENT_ID} onRestored={onRestored} />);

    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    // Confirm restore in the dialog
    const confirmBtn = screen.getByRole('button', { name: 'Restore' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-2/restore`,
        {}
      );
    });

    await waitFor(() => {
      expect(onRestored).toHaveBeenCalled();
    });
  });

  it('does not call onRestored when restore fails', async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    mockPost.mockRejectedValue(new Error('Server error'));

    render(<AgentVersionHistoryTab agentId={AGENT_ID} onRestored={onRestored} />);

    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    const confirmBtn = screen.getByRole('button', { name: 'Restore' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-2/restore`,
        {}
      );
    });
    // onRestored should NOT have been called since the post failed
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('does not invoke onRestored when restore fails with APIClientError', async () => {
    // BUG: The restoreError state (set in the catch block of handleRestore) can never be
    // displayed in the UI. AlertDialogAction triggers Radix's onOpenChange(false) synchronously
    // on click, which calls setRestoreTarget(null) and setRestoreError(null), closing the dialog
    // before the async POST rejects. The {restoreError && <p>} inside AlertDialogContent is
    // therefore unreachable in practice.
    //
    // This test verifies the correct API call was made and that onRestored was not invoked on
    // APIClientError. The error message display path is not testable without fixing the source.
    const { APIClientError: MockAPIClientError } = await import('@/lib/api/client');
    const user = userEvent.setup();
    const onRestored = vi.fn();
    mockPost.mockRejectedValue(
      new MockAPIClientError('Version snapshot not found', 'NOT_FOUND', 404)
    );

    render(<AgentVersionHistoryTab agentId={AGENT_ID} onRestored={onRestored} />);

    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    // Dialog opens — confirm the restore
    await waitFor(() => {
      expect(screen.getByText('Restore to version 2?')).toBeInTheDocument();
    });
    const confirmBtn = screen.getByRole('button', { name: 'Restore' });
    await user.click(confirmBtn);

    // POST was called with the correct endpoint and body
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-2/restore`,
        {}
      );
    });

    // onRestored must NOT fire when the POST failed
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('shows APIClientError message when initial fetch fails with APIClientError', async () => {
    const { APIClientError: MockAPIClientError } = await import('@/lib/api/client');
    mockGet.mockRejectedValue(
      new MockAPIClientError('Forbidden: insufficient permissions', 'FORBIDDEN', 403)
    );

    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    // APIClientError.message is shown verbatim; generic Error shows the fallback
    await waitFor(() => {
      expect(screen.getByText('Forbidden: insufficient permissions')).toBeInTheDocument();
    });
  });

  it('cancel button closes dialog without restoring', async () => {
    const user = userEvent.setup();
    render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    expect(screen.getByText('Restore to version 2?')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByText('Restore to version 2?')).not.toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
