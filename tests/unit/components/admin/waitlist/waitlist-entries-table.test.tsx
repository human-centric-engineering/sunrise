// @vitest-environment happy-dom

/**
 * WaitlistEntriesTable (§125 t-976)
 *
 * Over `GET /api/v1/admin/waitlist`. Pins what an admin sees and the requests
 * the table sends: the stale-response guard, a failed load that never reads as
 * empty, filters/search/sort in the query, row states, remove / restore /
 * erase, and the CSV export.
 *
 * @see components/admin/waitlist/waitlist-entries-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';

import {
  WaitlistEntriesTable,
  type WaitlistEntryRow,
  type WaitlistPage,
} from '@/components/admin/waitlist/waitlist-entries-table';
import { API } from '@/lib/api/endpoints';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

// The real APIClientError, so failures are read as they would be in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FIELDS: WaitlistFieldShape[] = [
  {
    key: 'role',
    label: 'Role',
    kind: 'select',
    options: [
      { value: 'dev', label: 'Developer' },
      { value: 'ops', label: 'Operations' },
    ],
  },
  { key: 'company', label: 'Company', kind: 'text' },
];

function entry(overrides: Partial<WaitlistEntryRow> = {}): WaitlistEntryRow {
  return {
    id: 'e1',
    email: 'alice@example.com',
    name: 'Alice',
    list: 'default',
    details: null,
    source: 'direct',
    utmSource: null,
    referrerHost: null,
    flaggedReason: null,
    confirmedAt: '2026-01-02T00:00:00.000Z',
    removedAt: null,
    rejoinRequests: 0,
    invitedAt: null,
    joinedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function page(entries: WaitlistEntryRow[], total = entries.length): WaitlistPage {
  return { entries, total };
}

function listResponse(entries: WaitlistEntryRow[], total = entries.length): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: entries,
      meta: { page: 1, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

function asString(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function urlOf(call: number): URL {
  const arg = mockFetch.mock.calls[call][0];
  return new URL(asString(arg), 'http://localhost');
}
const lastUrl = () => urlOf(mockFetch.mock.calls.length - 1);

function deferred() {
  let resolve: (r: Response) => void = () => {};
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderTable(props: Partial<React.ComponentProps<typeof WaitlistEntriesTable>> = {}) {
  return render(
    <WaitlistEntriesTable
      lists={['default']}
      fields={FIELDS}
      initial={page([entry()])}
      exportMaxRows={10000}
      {...props}
    />
  );
}

const rowOf = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;

async function getApi() {
  return import('@/lib/api/client');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn<typeof fetch>();
  mockFetch.mockImplementation(() => Promise.resolve(listResponse([])));
  vi.stubGlobal('fetch', mockFetch);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WaitlistEntriesTable — first render', () => {
  it('shows the server-rendered rows and does not fetch on mount', () => {
    renderTable({ initial: page([entry({ email: 'first@example.com' })], 1) });

    expect(screen.getByText('first@example.com')).toBeInTheDocument();
    expect(screen.getByText('1 person')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('server-renders "could not be loaded" and "Nothing to show." when the first read failed', () => {
    const html = renderToString(
      <WaitlistEntriesTable lists={['default']} fields={FIELDS} initial={null} exportMaxRows={10} />
    );

    expect(html).toContain('The waitlist could not be loaded.');
    expect(html).toContain('Nothing to show.');
    expect(html).not.toContain('No one matches.');
  });

  it('fetches on mount when the first read failed, and shows the rows it gets', async () => {
    mockFetch.mockResolvedValue(listResponse([entry({ email: 'later@example.com' })]));
    renderTable({ initial: null });

    expect(await screen.findByText('later@example.com')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it('keeps saying it could not be loaded when the retry on mount fails too', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 503 }));
    renderTable({ initial: null });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The waitlist could not be loaded. Please try again.'
    );
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — stale responses', () => {
  it('shows only the latest request’s rows when an older one resolves last', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const second = deferred();
    mockFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderTable();

    await user.click(screen.getByRole('checkbox', { name: /Show unconfirmed/ }));
    await user.click(screen.getByRole('checkbox', { name: /Show removed/ }));
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(listResponse([entry({ id: 'n', email: 'newer@example.com' })]));
    });
    expect(await screen.findByText('newer@example.com')).toBeInTheDocument();

    await act(async () => {
      first.resolve(listResponse([entry({ id: 'o', email: 'older@example.com' })]));
    });

    expect(screen.getByText('newer@example.com')).toBeInTheDocument();
    expect(screen.queryByText('older@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('1 person')).toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — a failed load never reads as empty', () => {
  const LOAD_FAILED = 'The waitlist could not be loaded. Please try again.';

  async function triggerLoad() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /Show unconfirmed/ }));
  }

  it('shows the alert and "Nothing to show." on a non-ok response', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    renderTable();
    await triggerLoad();

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
    expect(screen.queryByText('No one matches.')).not.toBeInTheDocument();
    // The old rows are gone, not left standing beside a failure.
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('shows the same on a malformed body', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [entry()] }), { status: 200 })
    );
    renderTable();
    await triggerLoad();

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
    expect(screen.queryByText('No one matches.')).not.toBeInTheDocument();
  });

  it('shows the same when the request itself throws', async () => {
    mockFetch.mockRejectedValue(new TypeError('network'));
    renderTable();
    await triggerLoad();

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
  });

  it('says "No one matches." for a successful empty page, with no alert', async () => {
    mockFetch.mockResolvedValue(listResponse([]));
    renderTable();
    await triggerLoad();

    expect(await screen.findByText('No one matches.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing to show.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — filters, search and sort in the query', () => {
  it.each([
    ['Show unconfirmed', 'includeUnconfirmed'],
    ['Show removed', 'includeRemoved'],
    ['Show signed up', 'includeJoined'],
    ['Flagged only', 'flaggedOnly'],
  ])('ticking "%s" sends %s=true; unticking drops it', async (label, param) => {
    const user = userEvent.setup();
    renderTable();
    const box = screen.getByRole('checkbox', { name: new RegExp(label) });

    await user.click(box);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(urlOf(0).pathname).toBe(API.ADMIN.WAITLIST);
    expect(urlOf(0).searchParams.get(param)).toBe('true');

    await user.click(box);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(urlOf(1).searchParams.has(param)).toBe(false);
  });

  it('resets to page 1 when a filter changes', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(() => Promise.resolve(listResponse([entry()], 60)));
    renderTable({ initial: page([entry()], 60) });

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(lastUrl().searchParams.get('page')).toBe('2');
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Flagged only/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(lastUrl().searchParams.get('page')).toBe('1');
    expect(lastUrl().searchParams.get('flaggedOnly')).toBe('true');
  });

  it('sends the search text trimmed as q only after the typing pause, once', async () => {
    renderTable();
    const input = screen.getByPlaceholderText('Address, name or answer');

    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.change(input, { target: { value: '  bob  ' } });
    expect(mockFetch).not.toHaveBeenCalled();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(lastUrl().searchParams.get('q')).toBe('bob');
    expect(lastUrl().searchParams.get('page')).toBe('1');
  });

  it('sorts: email starts ascending, dates start descending, a second click flips', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: /^Address/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(lastUrl().searchParams.get('sortBy')).toBe('email');
    expect(lastUrl().searchParams.get('sortOrder')).toBe('asc');

    await user.click(screen.getByRole('button', { name: /^Address/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(lastUrl().searchParams.get('sortBy')).toBe('email');
    expect(lastUrl().searchParams.get('sortOrder')).toBe('desc');

    await user.click(screen.getByRole('button', { name: /^Confirmed/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(lastUrl().searchParams.get('sortBy')).toBe('confirmedAt');
    expect(lastUrl().searchParams.get('sortOrder')).toBe('desc');

    await user.click(screen.getByRole('button', { name: /^Joined/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));
    expect(lastUrl().searchParams.get('sortBy')).toBe('createdAt');
    expect(lastUrl().searchParams.get('sortOrder')).toBe('desc');

    await user.click(screen.getByRole('button', { name: /^Joined/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(5));
    expect(lastUrl().searchParams.get('sortOrder')).toBe('asc');
  });

  it('shows the List filter and column only when there is more than one list', () => {
    const { unmount } = renderTable({ lists: ['default'] });
    expect(screen.queryByLabelText(/^List/)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'List' })).not.toBeInTheDocument();
    unmount();

    renderTable({ lists: ['default', 'beta'] });
    expect(screen.getByRole('combobox', { name: /^List/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'List' })).toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — row states and answers', () => {
  it('shows Unconfirmed only when confirmedAt is null', () => {
    renderTable({
      initial: page([
        entry({ id: 'a', email: 'unconf@example.com', confirmedAt: null }),
        entry({ id: 'b', email: 'conf@example.com' }),
      ]),
    });

    expect(within(rowOf('unconf@example.com')).getByText('Unconfirmed')).toBeInTheDocument();
    expect(within(rowOf('conf@example.com')).queryByText('Unconfirmed')).not.toBeInTheDocument();
  });

  it('shows the flag reason', () => {
    renderTable({ initial: page([entry({ flaggedReason: 'throwaway domain' })]) });
    expect(screen.getByText('Flagged: throwaway domain')).toBeInTheDocument();
  });

  it('shows Removed, and Re-submitted ×N only when removed with rejoin requests', () => {
    renderTable({
      initial: page([
        entry({
          id: 'a',
          email: 'rm-rejoin@example.com',
          removedAt: '2026-02-01T00:00:00Z',
          rejoinRequests: 3,
        }),
        entry({ id: 'b', email: 'rm-quiet@example.com', removedAt: '2026-02-01T00:00:00Z' }),
        entry({ id: 'c', email: 'live-rejoin@example.com', rejoinRequests: 2 }),
      ]),
    });

    const rejoin = within(rowOf('rm-rejoin@example.com'));
    expect(rejoin.getByText('Removed')).toBeInTheDocument();
    expect(rejoin.getByText('Re-submitted ×3')).toBeInTheDocument();

    const quiet = within(rowOf('rm-quiet@example.com'));
    expect(quiet.getByText('Removed')).toBeInTheDocument();
    expect(quiet.queryByText(/Re-submitted/)).not.toBeInTheDocument();

    const live = within(rowOf('live-rejoin@example.com'));
    expect(live.queryByText('Removed')).not.toBeInTheDocument();
    expect(live.queryByText(/Re-submitted/)).not.toBeInTheDocument();
  });

  it('shows Invited when invited and not joined, and Signed up once joined', () => {
    renderTable({
      initial: page([
        entry({ id: 'a', email: 'invited@example.com', invitedAt: '2026-02-01T00:00:00Z' }),
        entry({
          id: 'b',
          email: 'joined@example.com',
          invitedAt: '2026-02-01T00:00:00Z',
          joinedAt: '2026-02-02T00:00:00Z',
        }),
        entry({ id: 'c', email: 'plain@example.com' }),
      ]),
    });

    const invited = within(rowOf('invited@example.com'));
    expect(invited.getByText('Invited')).toBeInTheDocument();
    expect(invited.queryByText('Signed up')).not.toBeInTheDocument();

    const joined = within(rowOf('joined@example.com'));
    expect(joined.getByText('Signed up')).toBeInTheDocument();
    expect(joined.queryByText('Invited')).not.toBeInTheDocument();

    const plain = within(rowOf('plain@example.com'));
    expect(plain.queryByText('Invited')).not.toBeInTheDocument();
    expect(plain.queryByText('Signed up')).not.toBeInTheDocument();
  });

  it('shows declared answers as Label: value, using a select option’s label, skipping empty and non-string values', () => {
    renderTable({
      initial: page([
        entry({
          id: 'a',
          email: 'answers@example.com',
          details: { role: 'dev', company: 'Acme', undeclared: 'hidden' },
        }),
        entry({
          id: 'b',
          email: 'sparse@example.com',
          details: { role: '', company: 42 },
        }),
        entry({ id: 'c', email: 'raw@example.com', details: { role: 'unknown-option' } }),
      ]),
    });

    const full = within(rowOf('answers@example.com'));
    expect(full.getByText('Role: Developer')).toBeInTheDocument();
    expect(full.getByText('Company: Acme')).toBeInTheDocument();
    expect(full.queryByText(/hidden/)).not.toBeInTheDocument();
    expect(full.queryByText('Role: dev')).not.toBeInTheDocument();

    const sparse = rowOf('sparse@example.com');
    expect(within(sparse).queryByText(/Role:/)).not.toBeInTheDocument();
    expect(within(sparse).queryByText(/Company:/)).not.toBeInTheDocument();

    expect(within(rowOf('raw@example.com')).getByText('Role: unknown-option')).toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — Remove', () => {
  it('PATCHes removed:true for that entry, then reloads the table', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.patch).mockResolvedValue({});
    mockFetch.mockResolvedValue(listResponse([]));
    const user = userEvent.setup();
    renderTable({ initial: page([entry({ id: 'abc/1', email: 'gone@example.com' })]) });

    await user.click(within(rowOf('gone@example.com')).getByRole('button', { name: 'Remove' }));

    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.waitlistEntry('abc/1'), {
      body: { removed: true },
    });
    expect(await screen.findByText('No one matches.')).toBeInTheDocument();
    expect(screen.queryByText('gone@example.com')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('shows the fallback message when the update fails without a server message', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update the entry. Try again.'
    );
    // The row stays, and no reload happened.
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows the server’s message when the failure carries one', async () => {
    const { apiClient, APIClientError } = await getApi();
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('That entry was already erased', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That entry was already erased');
  });
});

describe('WaitlistEntriesTable — Restore', () => {
  const removed = (overrides: Partial<WaitlistEntryRow> = {}) =>
    entry({ id: 'r1', email: 'back@example.com', removedAt: '2026-02-01T00:00:00Z', ...overrides });

  it('asks first, and PATCHes removed:false only on confirm, then reloads', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.patch).mockResolvedValue({});
    mockFetch.mockResolvedValue(listResponse([entry({ id: 'r1', email: 'back@example.com' })]));
    const user = userEvent.setup();
    renderTable({ initial: page([removed()]) });

    await user.click(within(rowOf('back@example.com')).getByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Restore this person?');
    expect(apiClient.patch).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.waitlistEntry('r1'), {
        body: { removed: false },
      })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The reloaded row is no longer Removed.
    expect(within(rowOf('back@example.com')).queryByText('Removed')).not.toBeInTheDocument();
  });

  it('cancelling sends nothing', async () => {
    const { apiClient } = await getApi();
    const user = userEvent.setup();
    renderTable({ initial: page([removed()]) });

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('says how many times they tried to join again, singular and plural', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTable({ initial: page([removed({ rejoinRequests: 3 })]) });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'have tried to join again 3 times since'
    );
    unmount();

    renderTable({ initial: page([removed({ rejoinRequests: 1 })]) });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'have tried to join again 1 time since'
    );
  });

  it('does not mention re-joining when they never tried', async () => {
    const user = userEvent.setup();
    renderTable({ initial: page([removed()]) });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('They were taken off the list.');
    expect(dialog).not.toHaveTextContent('tried to join again');
  });

  it('keeps the dialog open with the error inside it when the restore fails', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderTable({ initial: page([removed()]) });

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not restore the entry. Try again.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('WaitlistEntriesTable — Erase', () => {
  it('opens a dialog, sends DELETE only on confirm, then reloads', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.delete).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(listResponse([]));
    const user = userEvent.setup();
    renderTable({ initial: page([entry({ id: 'x9', email: 'erase@example.com' })]) });

    await user.click(within(rowOf('erase@example.com')).getByRole('button', { name: 'Erase' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Erase this person?');
    expect(apiClient.delete).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Erase' }));

    await waitFor(() =>
      expect(apiClient.delete).toHaveBeenCalledWith(API.ADMIN.waitlistEntry('x9'))
    );
    expect(await screen.findByText('No one matches.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cancelling sends nothing', async () => {
    const { apiClient } = await getApi();
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Erase' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error inside it when the erase fails', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Erase' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Erase' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not erase the entry. Try again.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('WaitlistEntriesTable — Export', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicks: Array<{ download: string; href: string }>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:waitlist');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the row cap for the export', () => {
    renderTable({ exportMaxRows: 10000 });
    expect(screen.getByText('Up to 10,000 rows, with these filters')).toBeInTheDocument();
  });

  it('fetches the export with the current filters and downloads under the server’s filename', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation((input) =>
      asString(input).startsWith(API.ADMIN.WAITLIST_EXPORT)
        ? Promise.resolve(
            new Response('email\nalice@example.com', {
              status: 200,
              headers: { 'Content-Disposition': 'attachment; filename="waitlist-2026-11-04.csv"' },
            })
          )
        : Promise.resolve(listResponse([]))
    );
    renderTable();
    await user.click(screen.getByRole('checkbox', { name: /Show removed/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    const exportUrl = lastUrl();
    expect(exportUrl.pathname).toBe(API.ADMIN.WAITLIST_EXPORT);
    expect(exportUrl.searchParams.get('includeRemoved')).toBe('true');
    // Paging and sorting are not part of an export.
    expect(exportUrl.searchParams.has('page')).toBe(false);
    expect(clicks[0].download).toBe('waitlist-2026-11-04.csv');
    expect(clicks[0].href).toBe('blob:waitlist');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:waitlist');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('exports the search as typed, even before the table has caught up with it', async () => {
    mockFetch.mockImplementation((input) =>
      asString(input).startsWith(API.ADMIN.WAITLIST_EXPORT)
        ? Promise.resolve(new Response('email\n', { status: 200 }))
        : Promise.resolve(listResponse([]))
    );
    renderTable();

    // Typed, then Export at once: the 300 ms debounce has not fired, so the
    // table still shows every row. The export must not.
    fireEvent.change(screen.getByPlaceholderText('Address, name or answer'), {
      target: { value: ' acme.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    const exportCall = mockFetch.mock.calls.findIndex((c) =>
      asString(c[0]).startsWith(API.ADMIN.WAITLIST_EXPORT)
    );
    expect(urlOf(exportCall).searchParams.get('q')).toBe('acme.com');
  });

  it('falls back to waitlist.csv when the response names no file', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(new Response('email', { status: 200 }));
    renderTable();

    await user.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].download).toBe('waitlist.csv');
  });

  it('says "Too many exports just now" on a 429 and downloads nothing', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(new Response('', { status: 429 }));
    renderTable();

    await user.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many exports just now. Try again in a minute.'
    );
    expect(clicks).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('says "The export failed" on any other failure, including a thrown request', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    renderTable();

    await user.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The export failed. Please try again.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Too many exports');

    mockFetch.mockRejectedValueOnce(new TypeError('network'));
    await user.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The export failed. Please try again.')
    );
    expect(clicks).toHaveLength(0);
  });
});

describe('WaitlistEntriesTable — after a change (code review round 1)', () => {
  function pageResponse(entries: WaitlistEntryRow[], pageNo: number, total: number): Response {
    return new Response(
      JSON.stringify({
        success: true,
        data: entries,
        meta: { page: pageNo, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  it('steps back to the new last page when a change emptied the one it was on', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.patch).mockResolvedValue({});
    const first = Array.from({ length: 25 }, (_, i) =>
      entry({ id: `p1-${i}`, email: `p1-${i}@example.com` })
    );
    const last = entry({ id: 'only', email: 'last@example.com' });
    // 26 people: page 2 holds one. After removing it there are 25, one page.
    mockFetch.mockImplementation((input) => {
      const url = new URL(asString(input), 'http://localhost');
      const pageNo = Number(url.searchParams.get('page'));
      const removed = vi.mocked(apiClient.patch).mock.calls.length > 0;
      if (pageNo === 2)
        return Promise.resolve(pageResponse(removed ? [] : [last], 2, removed ? 25 : 26));
      return Promise.resolve(pageResponse(first, 1, removed ? 25 : 26));
    });
    const user = userEvent.setup();
    renderTable({ initial: page(first, 26) });

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('last@example.com');
    await user.click(within(rowOf('last@example.com')).getByRole('button', { name: 'Remove' }));

    // Not "No one matches." on a page 2 of 1: back to page 1 and its rows.
    expect(await screen.findByText('p1-0@example.com')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(lastUrl().searchParams.get('page')).toBe('1');
  });

  it('tells the page a remove happened, so the counts can follow, and not when it failed', async () => {
    const { apiClient } = await getApi();
    const onChanged = vi.fn();
    vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(apiClient.patch).mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderTable({ onChanged });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText(/Could not update the entry/);
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
