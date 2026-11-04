// @vitest-environment happy-dom

/**
 * The admin waitlist page's client half (§125 t-976): a change in the table
 * re-reads the counts, and a failed re-read keeps the last ones and says so.
 *
 * @see components/admin/waitlist/waitlist-admin.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { WaitlistAdmin } from '@/components/admin/waitlist/waitlist-admin';
import type { WaitlistListCountsView } from '@/components/admin/waitlist/waitlist-lists-panel';
import { API } from '@/lib/api/endpoints';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The table stands in with a button that reports a change, as a remove would.
const tableProps = vi.fn();
vi.mock('@/components/admin/waitlist/waitlist-entries-table', () => ({
  WaitlistEntriesTable: (props: { onChanged?: () => void; lists: string[] }) => {
    tableProps(props);
    return (
      <button type="button" onClick={() => props.onChanged?.()}>
        a change in the table
      </button>
    );
  },
}));

function counts(over: Partial<WaitlistListCountsView> = {}): WaitlistListCountsView {
  return {
    key: 'default',
    open: true,
    closedSince: null,
    confirmed: 5,
    unconfirmed: 0,
    flagged: 0,
    removed: 0,
    invited: 0,
    joined: 0,
    bySource: [],
    ...over,
  };
}

const confirmedShown = () =>
  within(screen.getByTestId('waitlist-list-default')).getByText('Confirmed').nextElementSibling
    ?.textContent;

let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAdmin(lists: WaitlistListCountsView[] | null = [counts()]) {
  return render(<WaitlistAdmin lists={lists} fields={[]} initial={null} exportMaxRows={10000} />);
}

describe('WaitlistAdmin', () => {
  it('re-reads the counts after a change in the table, and shows the new ones', async () => {
    mockFetch.mockResolvedValue(
      Response.json({ success: true, data: { lists: [counts({ confirmed: 4, removed: 1 })] } })
    );
    renderAdmin();
    expect(confirmedShown()).toBe('5');

    fireEvent.click(screen.getByRole('button', { name: 'a change in the table' }));

    await waitFor(() => expect(confirmedShown()).toBe('4'));
    expect(mockFetch.mock.calls[0][0]).toBe(API.ADMIN.WAITLIST_COUNTS);
    expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
  });

  it('keeps the last counts and says they may be stale when the re-read fails', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    renderAdmin();

    fireEvent.click(screen.getByRole('button', { name: 'a change in the table' }));

    expect(await screen.findByText(/may be out of date/)).toBeInTheDocument();
    expect(confirmedShown()).toBe('5');
  });

  it('says the lists could not be loaded when the first read failed, and still offers the table', () => {
    renderAdmin(null);

    expect(screen.getByRole('alert')).toHaveTextContent(
      "The waitlist's lists could not be loaded."
    );
    expect(tableProps).toHaveBeenCalledWith(expect.objectContaining({ lists: [] }));
  });

  it('hands the table the list keys', () => {
    renderAdmin([counts(), counts({ key: 'beta' })]);

    expect(tableProps).toHaveBeenCalledWith(
      expect.objectContaining({ lists: ['default', 'beta'] })
    );
  });
});

describe('WaitlistAdmin — a slow read from before a toggle (code review round 2)', () => {
  it('does not let it undo the close the admin made since', async () => {
    let finishStale: (r: Response) => void = () => {};
    let countsReads = 0;
    mockFetch.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          Response.json({
            success: true,
            data: { key: 'default', open: false, changedAt: '2026-11-04T10:00:00.000Z' },
          })
        );
      }
      if (url.includes(API.ADMIN.WAITLIST_COUNTS)) {
        countsReads += 1;
        // The first read (from the table's change) is slow and says open;
        // the toggle's own read says closed.
        if (countsReads === 1) {
          return new Promise<Response>((resolve) => {
            finishStale = resolve;
          });
        }
        return Promise.resolve(
          Response.json({
            success: true,
            data: { lists: [counts({ open: false, closedSince: '2026-11-04T10:00:00.000Z' })] },
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    renderAdmin();

    fireEvent.click(screen.getByRole('button', { name: 'a change in the table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close list' }));
    await waitFor(() => expect(countsReads).toBe(2));
    await screen.findByText('Closed');

    // The stale read lands last, saying the list is open.
    finishStale(Response.json({ success: true, data: { lists: [counts({ open: true })] } }));
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Taking joins')).not.toBeInTheDocument();
  });
});
