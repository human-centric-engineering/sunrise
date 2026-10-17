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
 * - Support rows (t-825): badge, expanded explanation, one-grant filter chip, support filter
 * - actionBadgeVariant: .create → default, .update → secondary, .delete → destructive, other → outline
 *
 * @see components/admin/orchestration/audit-log/audit-log-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogView } from '@/components/admin/orchestration/audit-log/audit-log-view';
import { logger } from '@/lib/logging';

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

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
    supportOrgId: null,
    supportGrant: null,
    ...overrides,
  };
}

/** The `meta` `paginatedResponse()` sends, at the view's 25 rows per page. */
function pageMeta(total: number, page = 1) {
  return { page, limit: 25, total, totalPages: Math.ceil(total / 25) };
}

function mockFetchSuccess(entries: unknown[], total = entries.length) {
  const body = JSON.stringify({ success: true, data: entries, meta: pageMeta(total) });
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
 * Freezes `setTimeout`, so the search box's 300ms debounce fires only when a
 * test calls `flushSearchDebounce()`. Waiting for it in real time raced the
 * timer when the machine was busy (t-799).
 *
 * Testing Library's async helpers — `findBy*`, `waitFor`, and every user-event
 * call, which runs through the same wrapper — drain with a `setTimeout(0)` that
 * never fires while timeouts are frozen. These tests therefore drive input with
 * the synchronous `fireEvent` and wait with `flushUntil`.
 */
function freezeTimeouts() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Fires a pending search debounce now; the fetch it triggers is called synchronously. */
async function flushSearchDebounce() {
  await act(() => vi.advanceTimersByTimeAsync(300));
}

/**
 * Re-checks `assertion` between microtask flushes inside `act`. The mocked
 * fetch settles on microtasks alone, so this needs no clock, real or fake.
 */
async function flushUntil(assertion: () => void) {
  for (let i = 0; i < 50; i++) {
    try {
      assertion();
      return;
    } catch {
      await act(async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      });
    }
  }
  assertion();
}

/** Waits for the in-flight fetch to finish (Refresh is disabled while loading). */
async function settle() {
  await flushUntil(() => expect(screen.getByRole('button', { name: /refresh/i })).toBeEnabled());
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
    freezeTimeouts();
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await flushUntil(() => screen.getByText('Support Bot'));

    const callsBefore = fetchUrls().length;
    fireEvent.change(screen.getByPlaceholderText(/filter by action/i), {
      target: { value: 'workflow' },
    });
    // Nothing is sent until the debounce window passes
    expect(fetchUrls().length).toBe(callsBefore);

    await flushSearchDebounce();

    expect(fetchUrls().slice(callsBefore)).toEqual([expect.stringContaining('q=workflow')]);
    await settle();
  });

  it('keeps the page when the search is typed and reverted within the debounce window', async () => {
    freezeTimeouts();
    mockFetchSuccess([makeEntry()], 50);

    render(<AuditLogView />);
    await flushUntil(() => screen.getByText(/1 \/ 2/));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await settle();
    const callsBefore = fetchUrls().length;

    // The query ends where it started, so nothing resets to page 1
    const searchInput = screen.getByPlaceholderText(/filter by action/i);
    fireEvent.change(searchInput, { target: { value: 'ab' } });
    fireEvent.change(searchInput, { target: { value: ' ' } });
    await flushSearchDebounce();

    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
    expect(fetchUrls().length).toBe(callsBefore);
  });

  it('resets to page=1 when search query changes', async () => {
    freezeTimeouts();
    // 50 entries at 25 per page → two pages
    mockFetchSuccess([makeEntry()], 50);

    render(<AuditLogView />);
    await flushUntil(() => screen.getByText(/1 \/ 2/));

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/filter by action/i), {
      target: { value: 'alice' },
    });
    await flushSearchDebounce();

    expect(lastFetchUrl()).toContain('page=1');
    expect(lastFetchUrl()).toContain('q=alice');
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
    await settle();
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

    await user.click(screen.getAllByRole('combobox')[0]);

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
    const entityTypeSelect = screen.getAllByRole('combobox')[0];
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
    freezeTimeouts();
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await flushUntil(() => screen.getByText('Support Bot'));

    const searchInput = screen.getByPlaceholderText(/filter by action/i);
    fireEvent.change(searchInput, { target: { value: 'workflow' } });
    await flushSearchDebounce();
    expect(lastFetchUrl()).toContain('q=workflow');

    // Clear the search — the next debounced fetch omits q
    const callsBefore = fetchUrls().length;
    fireEvent.change(searchInput, { target: { value: '' } });
    await flushSearchDebounce();

    expect(fetchUrls().length).toBeGreaterThan(callsBefore);
    expect(lastFetchUrl()).not.toContain('q=');
    await settle();
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
    await settle();
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
    await settle();
  });

  // Regression (t-799): the search debounce also ran on mount, and 300ms later
  // reset the page to 1, so paging straight after load bounced back.
  it('stays on page 2 when the search debounce window after load passes', async () => {
    freezeTimeouts();
    mockFetchSuccess([makeEntry()], 50);
    render(<AuditLogView />);
    await flushUntil(() => screen.getByText(/1 \/ 2/));

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    const callsAfterClick = fetchUrls().length;
    await flushSearchDebounce();

    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
    expect(fetchUrls().length).toBe(callsAfterClick);
    await settle();
  });

  // ── Out-of-order and failed requests ───────────────────────────────────────

  it('ignores a response that arrives after a newer request was made', async () => {
    const user = userEvent.setup();
    const json = (entry: ReturnType<typeof makeEntry>) =>
      new Response(JSON.stringify({ success: true, data: [entry], meta: pageMeta(50) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    // The late page=2 response. The test waits on the fetch promise and, if the
    // view goes on to read the body, on that too, so the stale request has had
    // its chance to write before the assertions run.
    let releasePage2: () => void = () => {};
    let page2Fetch: Promise<Response> | undefined;
    let page2BodyRead: Promise<unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=2')) {
        return (page2Fetch = new Promise<Response>((resolve) => {
          releasePage2 = () => {
            const res = json(makeEntry({ entityName: 'Page Two Row' }));
            const read = res.json.bind(res);
            res.json = () => (page2BodyRead = read());
            resolve(res);
          };
        }));
      }
      return Promise.resolve(json(makeEntry({ entityName: 'Page One Row' })));
    });

    render(<AuditLogView />);
    await screen.findByText('Page One Row');

    // page=2 hangs; going back to page 1 is the newer request and resolves first
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await user.click(screen.getByRole('button', { name: /previous page/i }));
    await settle();

    const logged = vi.mocked(logger.error).mock.calls.length;
    await act(async () => {
      releasePage2();
      await page2Fetch;
    });
    await act(async () => {
      await page2BodyRead;
    });

    expect(screen.getByText('Page One Row')).toBeInTheDocument();
    expect(screen.queryByText('Page Two Row')).not.toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
    expect(vi.mocked(logger.error).mock.calls.length).toBe(logged);
  });

  it('clears the previous page’s rows when the next page fails to load', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        url.includes('page=2')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(
              new Response(
                JSON.stringify({ success: true, data: [makeEntry()], meta: pageMeta(50) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            )
      );

    render(<AuditLogView />);
    await screen.findByText('Support Bot');

    await user.click(screen.getByRole('button', { name: /next page/i }));

    expect(await screen.findByText(/failed to load audit log/i)).toBeInTheDocument();
    expect(screen.queryByText('Support Bot')).not.toBeInTheDocument();
    expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument();
  });

  it('shows and logs the load error when fetch itself rejects', async () => {
    const failure = new TypeError('Failed to fetch');
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    render(<AuditLogView />);

    expect(await screen.findByText(/failed to load audit log/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeEnabled();
    expect(logger.error).toHaveBeenCalledWith('audit log fetch failed', failure);
  });

  it('shows the load error when the body is not JSON', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('<html>proxy error</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    render(<AuditLogView />);

    expect(await screen.findByText(/failed to load audit log/i)).toBeInTheDocument();
  });

  it.each([
    ['data is not an array', { success: true, data: null, meta: pageMeta(1) }],
    ['meta is missing', { success: true, data: [makeEntry()] }],
    ['meta has no total', { success: true, data: [makeEntry()], meta: { page: 1 } }],
  ])('shows the server error instead of rendering when %s', async (_case, payload) => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    render(<AuditLogView />);

    expect(await screen.findByText(/server returned an error/i)).toBeInTheDocument();
    expect(screen.queryByText('Support Bot')).not.toBeInTheDocument();
  });

  // ── Support sessions (t-825) ───────────────────────────────────────────────

  function supportEntry(overrides: Record<string, unknown> = {}) {
    return makeEntry({
      supportOrgId: 'org-acme',
      supportGrant: { id: 'grant-9', level: 'ADMIN', org: { id: 'org-acme', name: 'Acme' } },
      ...overrides,
    });
  }

  it('badges support rows with "Support" and leaves other rows unbadged', async () => {
    mockFetchSuccess([
      supportEntry({ id: 'e-s', user: { id: 'u-v', name: 'Vera Vendor', email: 'v@x.com' } }),
      makeEntry({ id: 'e-n' }),
    ]);
    render(<AuditLogView />);
    await screen.findByText('Vera Vendor');

    const [, supportRow, normalRow] = screen.getAllByRole('row');
    expect(within(supportRow).getByText('Support')).toBeInTheDocument();
    expect(within(normalRow).queryByText('Support')).not.toBeInTheDocument();
  });

  it('explains an admin-level support row when expanded', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([supportEntry()]);
    render(<AuditLogView />);
    await user.click(await screen.findByText('Support Bot'));

    expect(
      screen.getByText('Made during a support session in Acme, under a admin grant.')
    ).toBeInTheDocument();
  });

  it('says "read-only" for a READ_ONLY grant', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([
      supportEntry({
        supportGrant: { id: 'grant-9', level: 'READ_ONLY', org: { id: 'org-acme', name: 'Acme' } },
      }),
    ]);
    render(<AuditLogView />);
    await user.click(await screen.findByText('Support Bot'));

    expect(
      screen.getByText('Made during a support session in Acme, under a read-only grant.')
    ).toBeInTheDocument();
  });

  it('names the org id and offers no grant filter when the grant is erased', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([supportEntry({ supportGrant: null })]);
    render(<AuditLogView />);
    await user.click(await screen.findByText('Support Bot'));

    expect(
      screen.getByText('Made during a support session in erased org org-acme.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /show this grant.s actions/i })
    ).not.toBeInTheDocument();
  });

  it('does not explain or offer the grant button on a normal row', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry({ changes: { a: 1 } })]);
    render(<AuditLogView />);
    await user.click(await screen.findByText('Support Bot'));

    expect(screen.queryByText(/made during a support session/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /show this grant.s actions/i })
    ).not.toBeInTheDocument();
  });

  it('refetches with supportGrantId, shows the chip, and clears it with "Show every grant"', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([supportEntry()], 50);
    render(<AuditLogView />);
    await screen.findByText(/1 \/ 2/);
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await screen.findByText(/2 \/ 2/);
    expect(lastFetchUrl()).not.toContain('supportGrantId');

    await user.click(screen.getByText('Support Bot'));
    await user.click(screen.getByRole('button', { name: /show this grant.s actions/i }));

    expect(lastFetchUrl()).toContain('supportGrantId=grant-9');
    expect(lastFetchUrl()).toContain('page=1');
    expect(screen.getByText(/Showing actions under one support grant for/)).toHaveTextContent(
      'Showing actions under one support grant for Acme'
    );

    await user.click(screen.getByRole('button', { name: 'Show every grant' }));

    expect(lastFetchUrl()).not.toContain('supportGrantId');
    expect(screen.queryByText(/Showing actions under one support grant/)).not.toBeInTheDocument();
    await settle();
  });

  it('shows "Erased user" for a row whose user was erased', async () => {
    mockFetchSuccess([supportEntry({ userId: null, user: null })]);
    render(<AuditLogView />);

    expect(await screen.findByText('Erased user')).toBeInTheDocument();
  });

  it('drops the grant filter when "Not support sessions" is chosen', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([supportEntry()]);
    render(<AuditLogView />);
    await user.click(await screen.findByText('Support Bot'));
    await user.click(screen.getByRole('button', { name: /show this grant.s actions/i }));
    expect(lastFetchUrl()).toContain('supportGrantId=grant-9');

    await user.click(screen.getByRole('combobox', { name: 'Support sessions' }));
    await user.click(await screen.findByRole('option', { name: 'Not support sessions' }));

    await waitFor(() => expect(lastFetchUrl()).toContain('support=none'));
    expect(lastFetchUrl()).not.toContain('supportGrantId');
    expect(screen.queryByText(/Showing actions under one support grant/)).not.toBeInTheDocument();
  });

  it('offers the three support filter options', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await screen.findByText('Support Bot');

    await user.click(screen.getByRole('combobox', { name: 'Support sessions' }));

    expect(await screen.findByRole('option', { name: 'All actions' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Support sessions only' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Not support sessions' })).toBeInTheDocument();
  });

  it.each([
    ['Support sessions only', 'only'],
    ['Not support sessions', 'none'],
  ])('choosing "%s" sends support=%s', async (label, value) => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await screen.findByText('Support Bot');
    expect(lastFetchUrl()).not.toContain('support=');

    await user.click(screen.getByRole('combobox', { name: 'Support sessions' }));
    await user.click(await screen.findByRole('option', { name: label }));

    await waitFor(() => expect(lastFetchUrl()).toContain(`support=${value}`));

    // Back to "All actions" drops the param again
    await user.click(screen.getByRole('combobox', { name: 'Support sessions' }));
    await user.click(await screen.findByRole('option', { name: 'All actions' }));
    await waitFor(() => expect(lastFetchUrl()).not.toContain('support='));
  });
});
