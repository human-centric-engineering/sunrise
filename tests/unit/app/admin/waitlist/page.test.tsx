// @vitest-environment happy-dom

/**
 * Admin — Waitlist page (§125 t-976).
 *
 * The page does not exist while the app has no waitlist. With one, it reads
 * the counts and the first page through the API and hands them down; a read
 * that fails is reported in its place, never as an empty list. Only
 * `serverFetch` is faked: the real parser and `loadServerData` run.
 *
 * @see app/admin/waitlist/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockEnabled, notFoundError } = vi.hoisted(() => ({
  mockEnabled: { current: true },
  notFoundError: new Error('NEXT_NOT_FOUND'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
}));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  isWaitlistEnabled: () => mockEnabled.current,
}));
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const panelProps = vi.fn();
const tableProps = vi.fn();
vi.mock('@/components/admin/waitlist/waitlist-lists-panel', () => ({
  WaitlistListsPanel: (props: unknown) => {
    panelProps(props);
    return <div data-testid="lists-panel" />;
  },
}));
vi.mock('@/components/admin/waitlist/waitlist-entries-table', () => ({
  WaitlistEntriesTable: (props: unknown) => {
    tableProps(props);
    return <div data-testid="entries-table" />;
  },
}));

import WaitlistAdminPage from '@/app/admin/waitlist/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { WAITLIST_EXPORT_MAX_ROWS } from '@/lib/validations/waitlist';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const LISTS = [
  { key: 'default', open: true, confirmed: 2 },
  { key: 'beta', open: false },
];
const FIELDS = [{ key: 'role', label: 'Role', kind: 'text' }];
const ENTRIES = [{ id: 'e1' }, { id: 'e2' }];

/** Answer each admin path as the routes would. */
function serve(counts: Response, list: Response) {
  vi.mocked(serverFetch).mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/api/v1/admin/waitlist/counts') ? counts : list)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnabled.current = true;
});

describe('WaitlistAdminPage', () => {
  it('does not exist while the app has no waitlist, and reads nothing', async () => {
    mockEnabled.current = false;

    await expect(WaitlistAdminPage()).rejects.toBe(notFoundError);
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('reads the counts and the default first page through the API and hands them down', async () => {
    serve(
      apiSuccess({ lists: LISTS, fields: FIELDS }),
      apiSuccess(ENTRIES, { page: 1, limit: 25, total: 51, totalPages: 3 })
    );

    render(await WaitlistAdminPage());

    const paths = vi.mocked(serverFetch).mock.calls.map((c) => c[0]);
    expect(paths).toContain('/api/v1/admin/waitlist/counts');
    expect(paths).toContain(
      '/api/v1/admin/waitlist?page=1&limit=25&sortBy=createdAt&sortOrder=desc'
    );
    expect(panelProps).toHaveBeenCalledWith({ lists: LISTS, onListChange: expect.any(Function) });
    expect(tableProps).toHaveBeenCalledWith({
      lists: ['default', 'beta'],
      fields: FIELDS,
      initial: { entries: ENTRIES, total: 51 },
      exportMaxRows: WAITLIST_EXPORT_MAX_ROWS,
      onChanged: expect.any(Function),
    });
  });

  it('says the lists could not be loaded rather than showing none', async () => {
    serve(apiFailure(500), apiSuccess(ENTRIES, { page: 1, limit: 25, total: 2, totalPages: 1 }));

    render(await WaitlistAdminPage());

    expect(screen.getByRole('alert')).toHaveTextContent(
      "The waitlist's lists could not be loaded."
    );
    expect(panelProps).not.toHaveBeenCalled();
    // The table still renders, with no lists to choose between.
    expect(tableProps).toHaveBeenCalledWith(expect.objectContaining({ lists: [], fields: [] }));
  });

  it.each([
    ['a failed read', apiFailure(500)],
    ['a page with no pagination meta', apiSuccess(ENTRIES)],
  ])('hands the table no first page after %s, so it reports the failure', async (_label, list) => {
    serve(apiSuccess({ lists: LISTS, fields: FIELDS }), list);

    render(await WaitlistAdminPage());

    expect(tableProps).toHaveBeenCalledWith(expect.objectContaining({ initial: null }));
  });
});
