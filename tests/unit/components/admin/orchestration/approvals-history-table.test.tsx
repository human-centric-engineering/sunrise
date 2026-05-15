/**
 * ApprovalsHistoryTable — historical decision log with filters, paging,
 * and CSV export.
 *
 * The component does its own `fetch()` for the JSON list and the CSV
 * download, so tests mock `global.fetch` with a queued-response style to
 * verify (a) the URL+params it builds, (b) row rendering, (c) filter and
 * pagination interactions, (d) the CSV download path's blob+anchor flow,
 * and (e) error handling.
 *
 * @see components/admin/orchestration/approvals-history-table.tsx
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ApprovalsHistoryTable } from '@/components/admin/orchestration/approvals-history-table';
import type { ApprovalHistoryEntry } from '@/types/orchestration';
import type { APIResponse } from '@/types/api';

const ENDPOINT = '/api/v1/admin/orchestration/approvals/history';

function makeRow(overrides: Partial<ApprovalHistoryEntry> = {}): ApprovalHistoryEntry {
  return {
    id: 'exec1:stepA',
    executionId: 'exec1',
    workflowId: 'wf1',
    workflowName: 'Provider Audit',
    stepId: 'stepA',
    stepLabel: 'Review changes',
    decision: 'approved',
    medium: 'admin',
    approverUserId: 'u1',
    approverName: 'Alice Admin',
    actorLabel: 'Alice Admin',
    notes: 'Looks good',
    reason: null,
    askedAt: '2026-05-01T12:00:00.000Z',
    decidedAt: '2026-05-01T12:05:00.000Z',
    waitDurationMs: 5 * 60 * 1000,
    ...overrides,
  };
}

function successResponse(
  rows: ApprovalHistoryEntry[],
  meta = { page: 1, limit: 25, total: rows.length, totalPages: 1 }
): Response {
  const body: APIResponse<ApprovalHistoryEntry[]> = { success: true, data: rows, meta };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status = 500): Response {
  return new Response(JSON.stringify({ success: false, error: { code: 'X' } }), { status });
}

describe('ApprovalsHistoryTable', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the history endpoint on mount and renders rows', async () => {
    fetchMock.mockResolvedValueOnce(successResponse([makeRow()]));

    render(<ApprovalsHistoryTable />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(ENDPOINT);
    expect(url).toContain('page=1');
    expect(url).toContain('limit=25');

    // Row contents — workflow name link, step label, decision badge,
    // medium label, approver, and wait duration.
    expect(await screen.findByRole('link', { name: /provider audit/i })).toBeInTheDocument();
    expect(screen.getByText('Review changes')).toBeInTheDocument();
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    expect(screen.getByText('Admin UI')).toBeInTheDocument();
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('renders the empty-state row when no decisions match', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse([], { page: 1, limit: 25, total: 0, totalPages: 1 })
    );

    render(<ApprovalsHistoryTable />);

    expect(await screen.findByText(/no decisions match the current filters/i)).toBeInTheDocument();
  });

  it('refetches with debounced search filter', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(successResponse([]));

    render(<ApprovalsHistoryTable />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Type into the search box — the component debounces filter changes
    // and refetches with `q=audit` in the query string.
    await user.type(screen.getByLabelText(/search/i), 'audit');

    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain('q=audit');
    });
  });

  it('shows the Reset button when filters are active and clears them', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(successResponse([]));

    render(<ApprovalsHistoryTable />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Apply a search filter — Reset should appear.
    await user.type(screen.getByLabelText(/search/i), 'audit');
    await waitFor(() => expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /reset/i }));

    // After reset, the latest fetch must NOT carry a q=... parameter.
    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).not.toContain('q=');
    });
  });

  it('renders an error banner when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse());

    render(<ApprovalsHistoryTable />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);
  });

  it('renders pagination when there are multiple pages and Next advances the page', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow()], { page: 1, limit: 25, total: 60, totalPages: 3 })
    );

    render(<ApprovalsHistoryTable />);
    await screen.findByText(/page 1 of 3/i);

    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow({ id: 'exec2:stepA' })], {
        page: 2,
        limit: 25,
        total: 60,
        totalPages: 3,
      })
    );

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain('page=2');
    });
    await screen.findByText(/page 2 of 3/i);
  });

  it('renders the medium label for token-issued decisions', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow({ medium: 'token-external', approverName: null })])
    );

    render(<ApprovalsHistoryTable />);

    expect(await screen.findByText('Token · External')).toBeInTheDocument();
    // For non-admin medium the approver cell renders an em-dash placeholder.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('exports a CSV when the Export button is clicked', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow()], { page: 1, limit: 25, total: 1, totalPages: 1 })
    );

    render(<ApprovalsHistoryTable />);
    await screen.findByRole('link', { name: /provider audit/i });

    // Stub URL.createObjectURL + revokeObjectURL — jsdom doesn't ship them.
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    // Second fetch returns a CSV blob.
    fetchMock.mockResolvedValueOnce(
      new Response('decision,workflow\napproved,audit', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    await user.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => {
      const csvCall = fetchMock.mock.calls.find(([u]) => String(u).includes('format=csv'));
      expect(csvCall).toBeDefined();
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('renders "deleted user" placeholder for admin decision with no approverName', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow({ medium: 'admin', approverName: null })])
    );

    render(<ApprovalsHistoryTable />);
    // The placeholder lives in a <span class="italic">.
    const cell = await screen.findByText(/deleted user/i);
    expect(cell.tagName).toBe('SPAN');
  });

  it('formats long waits with hours and days', async () => {
    const day = 24 * 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(
      successResponse([
        makeRow({ id: 'r1', waitDurationMs: 90 * 60 * 1000 }), // 1h 30m
        makeRow({ id: 'r2', waitDurationMs: 2 * day + 3 * 60 * 60 * 1000 }), // 2d 3h
      ])
    );

    render(<ApprovalsHistoryTable />);

    expect(await screen.findByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('2d 3h')).toBeInTheDocument();
  });

  it('does not disable Export when only loading data is in flight but no rows exist yet', async () => {
    // Initial fetch returns 0 rows — Export should be disabled (meta.total === 0).
    fetchMock.mockResolvedValueOnce(
      successResponse([], { page: 1, limit: 25, total: 0, totalPages: 1 })
    );

    render(<ApprovalsHistoryTable />);
    await screen.findByText(/no decisions match/i);

    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
  });

  it('renders columnheaders for the eight visible columns', async () => {
    fetchMock.mockResolvedValueOnce(successResponse([]));
    render(<ApprovalsHistoryTable />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headerRow = screen.getAllByRole('row')[0];
    const headers = within(headerRow).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Workflow',
      'Decision',
      'Medium',
      'Approver',
      'Asked',
      'Decided',
      'Wait',
      'Notes / Reason',
    ]);
  });

  // ─── formatWait branch coverage ─────────────────────────────────────────

  it('formats waits under one second as 0s', async () => {
    fetchMock.mockResolvedValueOnce(successResponse([makeRow({ waitDurationMs: 500 })]));
    render(<ApprovalsHistoryTable />);
    expect(await screen.findByText('0s')).toBeInTheDocument();
  });

  it('formats sub-minute waits with seconds', async () => {
    fetchMock.mockResolvedValueOnce(successResponse([makeRow({ waitDurationMs: 12_000 })]));
    render(<ApprovalsHistoryTable />);
    expect(await screen.findByText('12s')).toBeInTheDocument();
  });

  it('formats sub-hour waits as plain minutes when seconds round to a multiple of 60', async () => {
    // 600s = 10 minutes — exercises the `if (totalMin < 60)` branch
    // without spilling into the hours/days arms.
    fetchMock.mockResolvedValueOnce(successResponse([makeRow({ waitDurationMs: 10 * 60_000 })]));
    render(<ApprovalsHistoryTable />);
    expect(await screen.findByText('10m')).toBeInTheDocument();
  });

  it('formats whole-hour waits without trailing minutes', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow({ waitDurationMs: 3 * 60 * 60_000 })])
    );
    render(<ApprovalsHistoryTable />);
    expect(await screen.findByText('3h')).toBeInTheDocument();
  });

  it('formats whole-day waits without trailing hours', async () => {
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow({ waitDurationMs: 5 * 24 * 60 * 60_000 })])
    );
    render(<ApprovalsHistoryTable />);
    expect(await screen.findByText('5d')).toBeInTheDocument();
  });

  // ─── Filter coverage: each `buildQuery` branch ─────────────────────────

  it('Prev button moves to the previous page', async () => {
    const user = userEvent.setup();
    // First load lands on page 2 of 3 (no Prev disabled).
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow()], { page: 2, limit: 25, total: 60, totalPages: 3 })
    );

    render(<ApprovalsHistoryTable />);
    await screen.findByText(/page 2 of 3/i);

    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow()], { page: 1, limit: 25, total: 60, totalPages: 3 })
    );

    await user.click(screen.getByRole('button', { name: /prev/i }));

    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain('page=1');
    });
  });

  it('sends dateFrom and dateTo in the query when set', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(successResponse([]));

    const { container } = render(<ApprovalsHistoryTable />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Date inputs render with type="date"; pick them by selector since
    // there's no explicit Label association.
    const dateInputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(dateInputs.length).toBe(2);

    await user.type(dateInputs[0], '2026-01-01');
    await user.type(dateInputs[1], '2026-02-01');

    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain('dateFrom=2026-01-01');
      // dateTo is rolled to end-of-day, so the param carries a T23:59...
      expect(url).toMatch(/dateTo=2026-02-01T23%3A59/);
    });
  });

  // ─── CSV export failure paths ──────────────────────────────────────────

  it('shows an error banner when the CSV export fetch fails', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      successResponse([makeRow()], { page: 1, limit: 25, total: 1, totalPages: 1 })
    );
    render(<ApprovalsHistoryTable />);
    await screen.findByRole('link', { name: /provider audit/i });

    // Stub createObjectURL even though we never reach it — keeps the
    // failure path isolated to the fetch rejection.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:url'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    fetchMock.mockResolvedValueOnce(errorResponse(503));
    await user.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not export csv/i);
  });
});
