// @vitest-environment happy-dom

/**
 * LeaseInspectorDialog Component Tests
 *
 * Test Coverage:
 * - Closed state: nothing fetched, nothing rendered
 * - Opens and fetches; renders current lease state fields
 * - Renders history rows with correct badge/text per event
 * - Shows empty-history copy when history is []
 * - Error banner when fetch rejects
 * - Null token renders as dash
 * - onClose is called when the dialog is dismissed via Escape
 * - Refetches with a new URL when executionId changes
 * - EVENT_VARIANT map wired correctly for 'force-failed' (destructive badge)
 *
 * @see components/admin/orchestration/lease-inspector-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LeaseInspectorDialog } from '@/components/admin/orchestration/lease-inspector-dialog';
import type {
  LeaseSnapshotView,
  LeaseEventView,
} from '@/components/admin/orchestration/lease-inspector-dialog';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EXEC_ID_A = 'exec-aaaaaa';
const EXEC_ID_B = 'exec-bbbbbb';

function makeCurrentLease(
  overrides: Partial<LeaseSnapshotView['current']> = {}
): LeaseSnapshotView['current'] {
  return {
    token: '…abc12',
    expiresAt: '2026-05-20T13:00:00Z',
    lastHeartbeatAt: '2026-05-20T12:59:30Z',
    recoveryAttempts: 2,
    ...overrides,
  };
}

function makeHistoryEvent(overrides: Partial<LeaseEventView> = {}, index = 0): LeaseEventView {
  return {
    id: `evt-${index}`,
    event: 'claimed',
    leaseToken: '…abc12',
    reason: null,
    metadata: null,
    createdAt: '2026-05-20T12:58:00Z',
    ...overrides,
  };
}

function makeSnapshot(
  opts: { history?: LeaseEventView[]; current?: Partial<LeaseSnapshotView['current']> } = {}
): LeaseSnapshotView {
  return {
    current: makeCurrentLease(opts.current),
    history: opts.history ?? [],
  };
}

/**
 * Build a mock fetch that responds with the Sunrise success envelope wrapping
 * the given snapshot. parseApiResponse validates { success, data } — we must
 * provide that shape rather than the raw snapshot.
 */
function mockFetchSuccess(snapshot: LeaseSnapshotView): void {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: snapshot }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function mockFetchHttpError(status = 500): void {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'server err' } }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  );
}

function mockFetchNetworkError(message = 'Network failure'): void {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LeaseInspectorDialog', () => {
  describe('closed state', () => {
    it('does not call fetch and does not render dialog content when executionId is null', () => {
      // Arrange: spy on fetch — it must not be called at all
      globalThis.fetch = vi.fn();
      const onClose = vi.fn();

      // Act
      render(<LeaseInspectorDialog executionId={null} onClose={onClose} />);

      // Assert: no fetch call and the dialog title is absent from the DOM
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(screen.queryByText('Lease inspector')).not.toBeInTheDocument();
    });
  });

  describe('open state — happy path', () => {
    it('fetches the lease and renders current-state fields', async () => {
      // Arrange
      const snapshot = makeSnapshot({
        current: {
          token: '…abc12',
          expiresAt: '2026-05-20T13:00:00Z',
          lastHeartbeatAt: '2026-05-20T12:59:30Z',
          recoveryAttempts: 2,
        },
        history: [],
      });
      mockFetchSuccess(snapshot);
      const onClose = vi.fn();

      // Act
      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={onClose} />);

      // Assert: fetch was fired with a URL that includes the execution id
      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain(EXEC_ID_A);
      expect(url).toContain('/lease');

      // Assert: field labels and the pre-redacted token value are rendered
      // (the component shows server-provided value as-is; no client redaction)
      await waitFor(() => {
        expect(screen.getByText('…abc12')).toBeInTheDocument();
      });
      // Recovery attempts field shows the number as a string
      expect(screen.getByText('2')).toBeInTheDocument();
      // Empty history copy is shown (history: [])
      expect(
        screen.getByText('No lease transitions recorded for this execution yet.')
      ).toBeInTheDocument();
    });
  });

  describe('history table', () => {
    it('renders a row per history event and shows the count in the section header', async () => {
      // Arrange: three distinct events
      const history: LeaseEventView[] = [
        makeHistoryEvent({ id: 'evt-0', event: 'claimed', leaseToken: '…aaa11' }, 0),
        makeHistoryEvent(
          { id: 'evt-1', event: 'orphan-resume', leaseToken: '…bbb22', reason: 'missed heartbeat' },
          1
        ),
        makeHistoryEvent({ id: 'evt-2', event: 'released', leaseToken: '…ccc33' }, 2),
      ];
      mockFetchSuccess(makeSnapshot({ history }));

      // Act
      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      // Assert: section header shows count
      await waitFor(() => {
        expect(screen.getByText('Recent events (3)')).toBeInTheDocument();
      });

      // Assert: all three event badges render (the component uses the event string as badge text)
      expect(screen.getByText('claimed')).toBeInTheDocument();
      expect(screen.getByText('orphan-resume')).toBeInTheDocument();
      expect(screen.getByText('released')).toBeInTheDocument();

      // Assert: empty-history copy is NOT shown when history is non-empty
      expect(
        screen.queryByText('No lease transitions recorded for this execution yet.')
      ).not.toBeInTheDocument();
    });

    it('shows empty-history copy when history array is empty', async () => {
      mockFetchSuccess(makeSnapshot({ history: [] }));

      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByText('No lease transitions recorded for this execution yet.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('error state', () => {
    it('shows error banner when fetch rejects with a network error', async () => {
      // Arrange: fetch rejects (network failure, no response at all)
      mockFetchNetworkError('Network failure');

      // Act
      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      // Assert: the banner appears containing the canonical prefix
      // The component renders: "Could not load lease inspector (<err>)."
      await waitFor(() => {
        expect(screen.getByText(/Could not load lease inspector/)).toBeInTheDocument();
      });

      // Assert: no history table is rendered
      expect(screen.queryByText(/Recent events/)).not.toBeInTheDocument();
    });

    it('shows error banner when fetch returns a non-OK HTTP status', async () => {
      // Arrange: HTTP 503 with no body the component can parse as success
      mockFetchHttpError(503);

      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      // Assert: banner appears (component catches the "HTTP 503" error it throws)
      await waitFor(() => {
        expect(screen.getByText(/Could not load lease inspector/)).toBeInTheDocument();
      });

      expect(screen.queryByText(/Recent events/)).not.toBeInTheDocument();
    });
  });

  describe('null token', () => {
    it('renders a dash when current.token is null', async () => {
      // Arrange: server has no active lease holder
      mockFetchSuccess(makeSnapshot({ current: { token: null } }));

      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      // Assert: the Token field shows '—' (the component does `token ?? '—'`)
      await waitFor(() => {
        // The Token field value should be '—'; confirm Token label is also present
        expect(screen.getByText('Token')).toBeInTheDocument();
      });
      // There is at least one '—' cell in the grid (Token field)
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onClose callback', () => {
    it('calls onClose when the user presses Escape to dismiss the dialog', async () => {
      // Arrange: open dialog with a valid execution id
      mockFetchSuccess(makeSnapshot());
      const onClose = vi.fn();
      const user = userEvent.setup();

      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={onClose} />);

      // Wait for dialog content to appear (Radix Dialog renders into a portal)
      await waitFor(() => {
        expect(screen.getByText('Lease inspector')).toBeInTheDocument();
      });

      // Act: Radix Dialog closes on Escape by default
      await user.keyboard('{Escape}');

      // Assert: onClose was invoked via the onOpenChange → if (!next) onClose() path
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('executionId change', () => {
    it('refetches with the new id URL when executionId prop changes', async () => {
      // Arrange: single fetch mock that handles both calls sequentially.
      // We must use a single vi.fn() across both renders so call counts accumulate.
      const successBody = JSON.stringify({ success: true, data: makeSnapshot() });
      const makeFetchResponse = (): Response =>
        new Response(successBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeFetchResponse()));
      globalThis.fetch = fetchMock;

      const onClose = vi.fn();
      const { rerender } = render(
        <LeaseInspectorDialog executionId={EXEC_ID_A} onClose={onClose} />
      );

      // Wait for the first fetch to complete before rerendering
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      // Act: change executionId to B — same fetchMock continues to accumulate calls
      rerender(<LeaseInspectorDialog executionId={EXEC_ID_B} onClose={onClose} />);

      // Assert: fetch was called twice total, second call used EXEC_ID_B in the URL
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const calls = fetchMock.mock.calls as [string][];
      expect(calls[0][0]).toContain(EXEC_ID_A);
      expect(calls[1][0]).toContain(EXEC_ID_B);
    });
  });

  describe('EVENT_VARIANT badge map', () => {
    it("renders a badge for 'force-failed' without crashing (destructive variant)", async () => {
      // Arrange: one history row with event='force-failed'
      // The component maps this to variant='destructive'
      const history: LeaseEventView[] = [
        makeHistoryEvent(
          { id: 'evt-ff', event: 'force-failed', reason: 'max retries exceeded' },
          0
        ),
      ];
      mockFetchSuccess(makeSnapshot({ history }));

      render(<LeaseInspectorDialog executionId={EXEC_ID_A} onClose={vi.fn()} />);

      // Assert: the badge text renders, proving EVENT_VARIANT wiring did not crash
      await waitFor(() => {
        expect(screen.getByText('force-failed')).toBeInTheDocument();
      });

      // Assert: the badge element has the destructive variant class applied
      // shadcn Badge with variant='destructive' receives class containing 'destructive'
      const badge = screen.getByText('force-failed');
      expect(badge.className).toMatch(/destructive/);
    });
  });
});
