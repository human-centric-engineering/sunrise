// @vitest-environment happy-dom

/**
 * Tests for `components/admin/orchestration/audit-log/audit-log-view.tsx`
 *
 * Key behaviours:
 * - Loading state on initial mount
 * - Renders audit entries (timestamp, action badge, entity, user, IP)
 * - Empty state: "No audit entries found."
 * - Search input: debounced and pushed server-side via `q` query param
 * - Expand row to reveal change diff JSON
 * - Pagination: next/prev buttons, shows page N / totalPages
 * - Refresh button re-fetches
 * - actionBadgeVariant: .create → default, .update → secondary, .delete → destructive, other → outline
 *
 * @see components/admin/orchestration/audit-log/audit-log-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogView } from '@/components/admin/orchestration/audit-log/audit-log-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        AUDIT_LOG: '/api/v1/admin/orchestration/audit-log',
      },
    },
  },
}));

// DatePicker → plain native input so existing change-event drivers still work
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({
    id,
    value,
    onChange,
    className,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    className?: string;
  }) => (
    <input
      id={id}
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    />
  ),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    userId: 'user-1',
    action: 'agent.create',
    entityType: 'agent',
    entityId: 'agent-1',
    entityName: 'Support Bot',
    changes: null,
    metadata: null,
    clientIp: '127.0.0.1',
    createdAt: '2026-01-15T10:00:00.000Z',
    user: { id: 'user-1', name: 'Alice Admin', email: 'alice@example.com' },
    ...overrides,
  };
}

function mockFetchSuccess(entries: unknown[], total = entries.length) {
  const body = JSON.stringify({ success: true, data: entries, meta: { total } });
  // Use mockImplementation to create a fresh Response per call (body can only be consumed once)
  globalThis.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
}

function fetchUrls(): string[] {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

function lastFetchUrl(): string {
  const urls = fetchUrls();
  return urls[urls.length - 1];
}

/**
 * Fires the search box's 300ms debounce now, rather than waiting for it in real
 * time: a wall-clock wait raced the timer when the machine was busy (t-799).
 * Needs `vi.useFakeTimers({ shouldAdvanceTime: true })` — the auto-advance keeps
 * Testing Library's own polling alive. The fetch the debounce triggers is called
 * synchronously in the effect, so it is recorded by the time this resolves.
 */
async function flushSearchDebounce() {
  await act(() => vi.advanceTimersByTimeAsync(300));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditLogView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchSuccess([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  it('shows loading message on initial mount', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(<AuditLogView />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows "No audit entries found." when list is empty', async () => {
    mockFetchSuccess([]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('No audit entries found.')).toBeInTheDocument();
    });
  });

  // ── Entry rows ────────────────────────────────────────────────────────────

  it('renders action badge, entity name, user, and IP', async () => {
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.create')).toBeInTheDocument();
      expect(screen.getByText('Support Bot')).toBeInTheDocument();
      expect(screen.getByText('Alice Admin')).toBeInTheDocument();
      expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
    });
  });

  it('shows "—" for null entityName (falls back to entityId)', async () => {
    mockFetchSuccess([makeEntry({ entityName: null, entityId: null })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  it('shows "—" for null clientIp', async () => {
    mockFetchSuccess([makeEntry({ clientIp: null })]);
    render(<AuditLogView />);
    await waitFor(() => {
      // Both entityName null fallback and IP null fallback → two "—" cells
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Action badge variants ──────────────────────────────────────────────────

  it('renders .update action without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'agent.update' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.update')).toBeInTheDocument();
    });
  });

  it('renders .delete action without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'agent.delete' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.delete')).toBeInTheDocument();
    });
  });

  it('renders unknown action (outline variant) without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'system.tick' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('system.tick')).toBeInTheDocument();
    });
  });

  // ── Expand row ────────────────────────────────────────────────────────────

  it('expands row to show changes JSON on click', async () => {
    const user = userEvent.setup();
    const changes = { name: { from: 'Old', to: 'New' } };
    mockFetchSuccess([makeEntry({ changes })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('agent.create'));

    await user.click(screen.getByText('Support Bot'));

    await waitFor(() => {
      expect(screen.getByText(/"from": "Old"/)).toBeInTheDocument();
    });
  });

  it('collapses row on second click', async () => {
    const user = userEvent.setup();
    const changes = { name: { from: 'Old', to: 'New' } };
    mockFetchSuccess([makeEntry({ changes })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    await user.click(screen.getByText('Support Bot'));
    await waitFor(() => screen.getByText(/"from": "Old"/));

    await user.click(screen.getByText('Support Bot'));
    await waitFor(() => {
      expect(screen.queryByText(/"from": "Old"/)).not.toBeInTheDocument();
    });
  });

  it('does not render change diff if changes is null', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry({ changes: null })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));
    await user.click(screen.getByText('Support Bot'));

    expect(screen.queryByRole('code')).not.toBeInTheDocument();
  });

  // ── Search filter (server-side via `q` query param) ──────────────────────

  it('debounces search input and sends q as a server-side query param', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await screen.findByText('Support Bot');

    await user.type(screen.getByPlaceholderText(/filter by action/i), 'workflow');
    await flushSearchDebounce();

    expect(lastFetchUrl()).toContain('q=workflow');
  });

  it('resets to page=1 when search query changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // 50 entries at 25 per page → two pages
    mockFetchSuccess([makeEntry()], 50);

    render(<AuditLogView />);
    await screen.findByText(/1 \/ 2/);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/filter by action/i), 'alice');
    await flushSearchDebounce();

    expect(lastFetchUrl()).toContain('page=1');
    expect(lastFetchUrl()).toContain('q=alice');
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
  });

  // ── Refresh ───────────────────────────────────────────────────────────────

  it('re-fetches when Refresh button is clicked', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('shows total entry count', async () => {
    mockFetchSuccess([makeEntry()], 42);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('42 entries')).toBeInTheDocument();
    });
  });

  it('shows "1 entry" for single entry', async () => {
    mockFetchSuccess([makeEntry()], 1);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('1 entry')).toBeInTheDocument();
    });
  });

  it('next page button is disabled when total fits on one page', async () => {
    mockFetchSuccess([makeEntry()], 5); // 5 total, 25 per page → 1 page → totalPages = 1
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    // Page indicator: "1 / 1"
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
  });

  it('prev page button is disabled on first page', async () => {
    mockFetchSuccess([makeEntry()], 5);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
  });

  it('shows error message when fetch returns non-ok response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load audit log/i)).toBeInTheDocument();
    });
  });

  it('shows error when API returns success: false', async () => {
    const body = JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'oops' } });
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
      );
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText(/server returned an error/i)).toBeInTheDocument();
    });
  });

  it('collapses expanded row when data is re-fetched', async () => {
    const user = userEvent.setup();
    const changes = { name: { from: 'Old', to: 'New' } };
    mockFetchSuccess([makeEntry({ changes })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    // Expand the row
    await user.click(screen.getByText('Support Bot'));
    await waitFor(() => {
      expect(screen.getByText(/"from": "Old"/)).toBeInTheDocument();
    });

    // Trigger a re-fetch via Refresh
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    // Expanded content should disappear
    await waitFor(() => {
      expect(screen.queryByText(/"from": "Old"/)).not.toBeInTheDocument();
    });
  });

  it('clears stale error when a new fetch begins', async () => {
    const user = userEvent.setup();

    // First fetch fails → error visible
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load audit log/i)).toBeInTheDocument();
    });

    // Next fetch succeeds — swap mock and trigger via Refresh
    mockFetchSuccess([makeEntry()]);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    // Error should disappear once the new fetch starts (before response arrives)
    await waitFor(() => {
      expect(screen.queryByText(/failed to load audit log/i)).not.toBeInTheDocument();
    });
  });

  // ── formatDate ────────────────────────────────────────────────────────────

  it('renders formatted timestamp in a human-readable form', async () => {
    mockFetchSuccess([makeEntry({ createdAt: '2026-01-15T10:00:00.000Z' })]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    // The formatted date should contain at least the year 2026 and month indication
    // formatDate uses toLocaleString with day/month/year/hour/minute
    const timestampCells = screen
      .getAllByRole('cell')
      .filter((cell) => cell.textContent?.includes('2026') || cell.textContent?.includes('Jan'));
    expect(timestampCells.length).toBeGreaterThan(0);
  });

  // ── Entity type dropdown filter ────────────────────────────────────────────

  it('exposes all expected entity-type options', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: /all types/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^workflows$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^capabilities$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^providers$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^MCP API keys$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^knowledge$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^experiments$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^embed tokens$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^backups$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^event hooks$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^webhook subscriptions$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^conversations$/i })).toBeInTheDocument();
  });

  it('calls fetch with entityType param when entity type is changed', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Open the entity type select and choose "Agents"
    const entityTypeSelect = screen.getByRole('combobox');
    await user.click(entityTypeSelect);
    await user.click(await screen.findByRole('option', { name: /^agents$/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });

    // Verify entityType=agent was included in the URL
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastUrl = calls[calls.length - 1][0] as string;
    expect(lastUrl).toContain('entityType=agent');
  });

  it('omits q from the URL when the search input is empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await screen.findByText('Support Bot');

    const searchInput = screen.getByPlaceholderText(/filter by action/i);
    await user.type(searchInput, 'workflow');
    await flushSearchDebounce();
    expect(lastFetchUrl()).toContain('q=workflow');

    // Clear the search — the next debounced fetch omits q
    const callsBefore = fetchUrls().length;
    await user.clear(searchInput);
    await flushSearchDebounce();

    expect(fetchUrls().length).toBeGreaterThan(callsBefore);
    expect(lastFetchUrl()).not.toContain('q=');
  });

  it('falls back to entityId when entityName is null but entityId is present', async () => {
    mockFetchSuccess([makeEntry({ entityName: null, entityId: 'agent-fallback-id' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent-fallback-id')).toBeInTheDocument();
    });
  });

  // ── Date range filters ─────────────────────────────────────────────────────

  it('sends dateFrom and dateTo query params when date inputs are set', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    const fromInput = screen.getByLabelText(/from/i);
    const toInput = screen.getByLabelText(/to/i);

    await user.clear(fromInput);
    await user.type(fromInput, '2026-01-01');
    await user.clear(toInput);
    await user.type(toInput, '2026-01-31');

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const lastUrl = calls[calls.length - 1][0] as string;
      expect(lastUrl).toContain('dateFrom=2026-01-01');
      expect(lastUrl).toContain('dateTo=2026-01-31');
    });
  });

  // ── Metadata rendering ───────────────────────────────────────────────────

  it('shows metadata alongside changes in expanded row', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([
      makeEntry({
        changes: { name: { from: 'A', to: 'B' } },
        metadata: { eventType: 'conversation.message' },
      }),
    ]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    await user.click(screen.getByText('Support Bot'));

    await waitFor(() => {
      expect(screen.getByText('Changes')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
      expect(screen.getByText(/eventType/)).toBeInTheDocument();
    });
  });

  it('shows metadata even when changes is null', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([
      makeEntry({
        changes: null,
        metadata: { reason: 'scheduled' },
      }),
    ]);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    await user.click(screen.getByText('Support Bot'));

    await waitFor(() => {
      expect(screen.getByText('Metadata')).toBeInTheDocument();
      expect(screen.getByText(/scheduled/)).toBeInTheDocument();
      expect(screen.queryByText('Changes')).not.toBeInTheDocument();
    });
  });

  // ── Pagination navigation ──────────────────────────────────────────────────

  // Changing page sets state and fetches in the same commit, and `user.click`
  // resolves after that commit, so the request and the counter are both there
  // to assert on straight away — no wait for a re-render.

  it('clicking next page button triggers a new fetch with page=2', async () => {
    const user = userEvent.setup();
    // Set total to 50 so there are multiple pages (25 per page → 2 pages)
    mockFetchSuccess([makeEntry()], 50);
    render(<AuditLogView />);
    await screen.findByText(/1 \/ 2/);

    const nextButton = screen.getByRole('button', { name: /next page/i });
    expect(nextButton).not.toBeDisabled();
    const callsBefore = fetchUrls().length;
    await user.click(nextButton);

    expect(fetchUrls().slice(callsBefore)).toEqual([expect.stringContaining('page=2')]);
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
  });

  it('clicking prev page button from page 2 triggers fetch with page=1', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()], 50);
    render(<AuditLogView />);
    await screen.findByText(/1 \/ 2/);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();

    const callsBefore = fetchUrls().length;
    await user.click(screen.getByRole('button', { name: /previous page/i }));

    expect(fetchUrls().slice(callsBefore)).toEqual([expect.stringContaining('page=1')]);
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
  });

  // Regression (t-799): the search debounce also ran on mount, and 300ms later
  // reset the page to 1, so paging straight after load bounced back.
  it('stays on page 2 when the search debounce window after load passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetchSuccess([makeEntry()], 50);
    render(<AuditLogView />);
    await screen.findByText(/1 \/ 2/);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    const callsAfterClick = fetchUrls().length;
    await flushSearchDebounce();

    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
    expect(fetchUrls().length).toBe(callsAfterClick);
  });
});
