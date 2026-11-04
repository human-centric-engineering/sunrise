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
