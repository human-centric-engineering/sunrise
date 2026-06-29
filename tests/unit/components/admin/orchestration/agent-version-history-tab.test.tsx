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
        agentVersionById: (id: string, vId: string) =>
          `/api/v1/admin/orchestration/agents/${id}/versions/${vId}`,
        agentVersionRestore: (id: string, vId: string) =>
          `/api/v1/admin/orchestration/agents/${id}/versions/${vId}/restore`,
        agentById: (id: string) => `/api/v1/admin/orchestration/agents/${id}`,
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
    // The component fires a single mount-time GET (the versions list); per-row
    // snapshots are fetched lazily on expand. Route the default mock by URL so
    // list-focused tests pass and any version-detail fetch resolves to an empty
    // snapshot they don't care about.
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/versions?limit')) return Promise.resolve(VERSIONS);
      if (/\/versions\/ver-/.test(url))
        return Promise.resolve({ id: 'x', version: 0, snapshot: {} });
      return Promise.resolve({});
    });
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
      expect(onRestored).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
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
    expect(onRestored).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows the error and keeps the dialog open when restore fails with APIClientError', async () => {
    // Regression guard for the silent-failure bug: the confirm button is a Radix
    // AlertDialogAction, which closes the dialog on click — so `restoreError` (set in
    // handleRestore's catch and rendered only inside the dialog) was never visible. The
    // fix calls e.preventDefault() in the action's onClick so the dialog stays open on
    // failure; handleRestore closes it itself only on success. This covers e.g. the 403
    // returned for system agents, plus any 404/500/network failure on a normal agent.
    const { APIClientError: MockAPIClientError } = await import('@/lib/api/client');
    const user = userEvent.setup();
    const onRestored = vi.fn();
    mockPost.mockRejectedValue(
      new MockAPIClientError('Cannot restore versions on system agents', 'FORBIDDEN', 403)
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

    // The server's error message is now surfaced to the user...
    await waitFor(() => {
      expect(screen.getByText('Cannot restore versions on system agents')).toBeInTheDocument();
    });
    // ...and the dialog stays open so they can read it / retry / cancel.
    expect(screen.getByText('Restore to version 2?')).toBeInTheDocument();

    // onRestored must NOT fire when the POST failed
    expect(onRestored).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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

  // ─── Expandable diff ────────────────────────────────────────────────────────
  //
  // Snapshots are POINT-IN-TIME — `versions[i].snapshot` is the config AS OF
  // that version (the post-save state). Versions are newest-first, so for the
  // row at index i:
  //   • After  = versions[i].snapshot   (this version's own state)
  //   • Before = versions[i+1].snapshot (the next-OLDER version), or null for
  //              the oldest row, which then shows the full initial config.
  // The newest row equals live by construction, so there's no live-agent fetch.
  describe('expandable diff', () => {
    // Each row's snapshot is the state AS OF that version (post-save). ver-3 is
    // newest (== live), ver-1 is the initial configuration.
    const SNAPSHOTS: Record<string, { snapshot: Record<string, unknown> }> = {
      'ver-3': {
        // State as of v3 (newest = live).
        snapshot: {
          model: 'claude-opus-4-6',
          temperature: 0.9,
          systemInstructions: 'You are concise and helpful.',
        },
      },
      'ver-2': {
        // State as of v2.
        snapshot: {
          model: 'claude-sonnet-4-6',
          temperature: 0.7,
          systemInstructions: 'You are concise and helpful.',
        },
      },
      'ver-1': {
        // Initial configuration (v1).
        snapshot: {
          model: 'claude-sonnet-4-6',
          temperature: 0.5,
          systemInstructions: 'Initial system prompt.',
        },
      },
    };

    function routeFetch(url: string): Promise<unknown> {
      if (url.endsWith('/versions?limit=50')) return Promise.resolve(VERSIONS);
      const detailMatch = url.match(/\/versions\/(ver-[^/]+)$/);
      if (detailMatch) {
        const id = detailMatch[1];
        const detail = SNAPSHOTS[id];
        if (!detail) return Promise.reject(new Error(`unknown version ${id}`));
        return Promise.resolve({ id, version: 0, ...detail });
      }
      // No live-agent fetch in the point-in-time model.
      return Promise.reject(new Error(`unmatched URL: ${url}`));
    }

    beforeEach(() => {
      mockGet.mockImplementation((url: string) => routeFetch(url));
    });

    it('expands the newest row and diffs its snapshot against the next-older version', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Updated model to claude-opus-4-6'));

      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: 'Field' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'After' })).toBeInTheDocument();
      });

      // Before = ver-2 (the next-older version): model claude-sonnet-4-6, temp 0.7
      // After  = ver-3 (this version):           model claude-opus-4-6,  temp 0.9
      expect(screen.getByText('Model')).toBeInTheDocument();
      expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
      expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      // ver-1's distinctive values must NOT appear under v3's diff — regression
      // guard for diffing against the wrong neighbour.
      expect(screen.queryByText('Initial system prompt.')).not.toBeInTheDocument();
      expect(screen.queryByText('0.5')).not.toBeInTheDocument();
    });

    it('expands an older row and diffs against the next-OLDER snapshot', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v2')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Changed temperature'));

      // Before = ver-1 (next-older), After = ver-2 (this version):
      //   temperature: 0.5 → 0.7
      //   systemInstructions: 'Initial system prompt.' → 'You are concise…'
      await waitFor(() => {
        expect(screen.getByText('0.5')).toBeInTheDocument();
        expect(screen.getByText('0.7')).toBeInTheDocument();
      });
      expect(screen.getByText('Initial system prompt.')).toBeInTheDocument();
      // The newer (v3) state is NOT involved — only this version + its older
      // neighbour. claude-opus-4-6 belongs to ver-3.
      expect(screen.queryByText('claude-opus-4-6')).not.toBeInTheDocument();
    });

    it('caches snapshots — each version snapshot is fetched at most once', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Expand v3 → fetches ver-3 (its own snapshot = After) and ver-2 (the
      // older neighbour = Before).
      await user.click(screen.getByText('Updated model to claude-opus-4-6'));
      await waitFor(() => {
        const urls = mockGet.mock.calls.map(([u]) => String(u));
        expect(urls).toContain(`/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-3`);
        expect(urls).toContain(`/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-2`);
      });

      // Expand v2 → ver-2 is already cached from the v3 expand; only ver-1 (its
      // older neighbour) is newly fetched.
      await user.click(screen.getByText('Changed temperature'));
      await waitFor(() => {
        const urls = mockGet.mock.calls.map(([u]) => String(u));
        expect(urls).toContain(`/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-1`);
      });

      // Each version detail URL should appear at most once.
      const detailCounts: Record<string, number> = {};
      for (const [u] of mockGet.mock.calls) {
        const m = String(u).match(/\/versions\/(ver-[^/]+)$/);
        if (m) detailCounts[m[1]] = (detailCounts[m[1]] ?? 0) + 1;
      }
      for (const count of Object.values(detailCounts)) {
        expect(count).toBe(1);
      }
    });

    it('diffs the OLDEST row against null — shows the full initial config', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v1')).toBeInTheDocument();
      });

      // Oldest row (Initial configuration) has no older neighbour, so Before is
      // null and every field shows as its initial value.
      await user.click(screen.getByText('Configuration updated'));

      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'After' })).toBeInTheDocument();
      });
      // ver-1 (initial) values surface as the "After" column.
      expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
      expect(screen.getByText('0.5')).toBeInTheDocument();
      expect(screen.getByText('Initial system prompt.')).toBeInTheDocument();
    });

    it('collapses the row when clicked a second time', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      const trigger = screen.getByText('Updated model to claude-opus-4-6');
      await user.click(trigger);

      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: 'Field' })).toBeInTheDocument();
      });

      await user.click(trigger);

      await waitFor(() => {
        expect(screen.queryByRole('columnheader', { name: 'Field' })).not.toBeInTheDocument();
      });
    });

    it('shows a snapshot error inline without breaking the rest of the list', async () => {
      const { APIClientError: MockAPIClientError } = await import('@/lib/api/client');
      mockGet.mockImplementation((url: string) => {
        if (url.endsWith('/versions?limit=50')) return Promise.resolve(VERSIONS);
        if (/\/versions\/ver-3$/.test(url)) {
          return Promise.reject(
            new MockAPIClientError('Snapshot is unavailable', 'NOT_FOUND', 404)
          );
        }
        return Promise.resolve({ id: 'x', version: 0, snapshot: {} });
      });

      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Updated model to claude-opus-4-6'));

      await waitFor(() => {
        expect(screen.getByText('Snapshot is unavailable')).toBeInTheDocument();
      });

      // Other rows remain usable — the list fetch succeeded.
      expect(screen.getByText('v2')).toBeInTheDocument();
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
    expect(mockPost).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });
});
