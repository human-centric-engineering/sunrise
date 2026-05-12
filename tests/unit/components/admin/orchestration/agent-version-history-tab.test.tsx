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
    // The component fires two mount-time GETs (versions list + live
    // agent state). Route the default mock by URL so existing tests
    // that focus on the list still pass, and the agent fetch
    // resolves to an empty live snapshot they don't care about.
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/versions?limit')) return Promise.resolve(VERSIONS);
      if (/\/versions\/ver-/.test(url))
        return Promise.resolve({ id: 'x', version: 0, snapshot: {} });
      // /agents/:id — the live agent state.
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
  // Snapshots capture PRE-update state (see the PATCH route writer),
  // so for the row at index i:
  //   • Before = versions[i].snapshot
  //   • After  = versions[i-1].snapshot if a newer row exists,
  //              else the LIVE agent state for the newest row.
  describe('expandable diff', () => {
    // Each row's snapshot is the state JUST BEFORE the save that
    // created that row. The live agent state is what the most recent
    // save (v3) wrote out.
    const SNAPSHOTS: Record<string, { snapshot: Record<string, unknown> }> = {
      'ver-3': {
        // Pre-save-3 = post-save-2.
        snapshot: {
          model: 'claude-opus-4-6',
          temperature: 0.9,
          systemInstructions: 'You are concise and helpful.',
        },
      },
      'ver-2': {
        // Pre-save-2 = post-save-1.
        snapshot: {
          model: 'claude-sonnet-4-6',
          temperature: 0.7,
          systemInstructions: 'You are concise and helpful.',
        },
      },
      'ver-1': {
        // Pre-save-1 = initial post-create state.
        snapshot: {
          model: 'claude-sonnet-4-6',
          temperature: 0.5,
          systemInstructions: 'Initial system prompt.',
        },
      },
    };

    const LIVE_AGENT = {
      // Post-save-3 — what the most recent save committed.
      model: 'claude-opus-4-7',
      temperature: 0.95,
      systemInstructions: 'You are concise and helpful.',
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
      // Live agent endpoint — /agents/:id (no trailing /versions).
      if (/\/agents\/[^/]+$/.test(url)) return Promise.resolve(LIVE_AGENT);
      return Promise.reject(new Error(`unmatched URL: ${url}`));
    }

    beforeEach(() => {
      mockGet.mockImplementation((url: string) => routeFetch(url));
    });

    it('expands the newest row and diffs its snapshot against the LIVE agent state', async () => {
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

      // v3.snapshot.model (Before) = claude-opus-4-6
      // live.model (After) = claude-opus-4-7
      expect(screen.getByText('Model')).toBeInTheDocument();
      expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument();
      // Older-still values from ver-2 must NOT appear under v3's diff —
      // regression guard for the "shifted by one save" bug.
      expect(screen.queryByText('claude-sonnet-4-6')).not.toBeInTheDocument();
    });

    it('expands an older row and diffs against the next-newer snapshot', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v2')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Changed temperature'));

      // v2.snapshot (Before) → v3.snapshot (After):
      //   model: claude-sonnet-4-6 → claude-opus-4-6
      //   temperature: 0.7 → 0.9
      await waitFor(() => {
        expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
        expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
      });
      // Live state is NOT involved here — only adjacent snapshots.
      expect(screen.queryByText('claude-opus-4-7')).not.toBeInTheDocument();
    });

    it('caches snapshots — each version snapshot is fetched at most once', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Expand v3 → fetches ver-3 (its own snapshot = Before).
      // The "After" comes from the live agent fetch that already
      // happened at mount, so no extra version fetch.
      await user.click(screen.getByText('Updated model to claude-opus-4-6'));
      await waitFor(() => {
        const urls = mockGet.mock.calls.map(([u]) => String(u));
        expect(urls).toContain(`/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-3`);
      });

      // Expand v2 → fetches ver-2; ver-3 is already cached.
      await user.click(screen.getByText('Changed temperature'));
      await waitFor(() => {
        const urls = mockGet.mock.calls.map(([u]) => String(u));
        expect(urls).toContain(`/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/ver-2`);
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

    it('diffs the OLDEST row against the next-newer snapshot (initial → first save result)', async () => {
      const user = userEvent.setup();
      render(<AgentVersionHistoryTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('v1')).toBeInTheDocument();
      });

      // v1.snapshot (Before — initial pre-save-1 state)
      // → v2.snapshot (After — post-save-1 state).
      await user.click(screen.getByText('Configuration updated'));

      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'After' })).toBeInTheDocument();
      });
      // temperature: 0.5 (v1) → 0.7 (v2)
      expect(screen.getByText('0.5')).toBeInTheDocument();
      expect(screen.getByText('0.7')).toBeInTheDocument();
      // systemInstructions: 'Initial system prompt.' (v1) → 'You are concise…' (v2)
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
        if (/\/agents\/[^/]+$/.test(url)) return Promise.resolve(LIVE_AGENT);
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
