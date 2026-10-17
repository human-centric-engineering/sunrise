// @vitest-environment happy-dom

/**
 * SupportActivityTable (§121 t-825): what support did in an org, one request
 * per page or grant chosen, each row naming the grant it was made under.
 *
 * @see components/admin/support-access/support-activity-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SupportActivityTable } from '@/components/admin/support-access/support-activity-table';
import type { SupportGrantRow } from '@/components/admin/support-access/support-grants-table';

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const grant = (over: Partial<SupportGrantRow>): SupportGrantRow => ({
  id: 'g-1',
  level: 'ADMIN',
  reason: 'Ticket 42',
  expiresAt: '2026-10-17T12:00:00.000Z',
  createdAt: '2026-10-16T12:00:00.000Z',
  revokedAt: null,
  grantedBy: { id: 'u-1', name: 'Olive Owner' },
  revokedBy: null,
  open: true,
  ...over,
});

const LONG_REASON = 'A very long reason that goes well past forty characters in total';
const GRANTS = [
  grant({}),
  grant({ id: 'g-2', reason: LONG_REASON, createdAt: '2026-09-01T12:00:00.000Z', open: false }),
];

/** The label the table gives a grant: created date, then reason. */
function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    grantId: 'g-1',
    action: 'agent.update',
    entityType: 'agent',
    entityId: 'agent-1',
    entityName: 'Support Bot',
    createdAt: '2026-10-16T13:00:00.000Z',
    actor: { id: 'u-9', name: 'Vera Vendor' },
    ...over,
  };
}

function meta(total: number, page = 1) {
  return { page, limit: 25, total, totalPages: Math.ceil(total / 25) };
}

function mockActivity(rows: unknown[], total = rows.length) {
  const body = JSON.stringify({ success: true, data: rows, meta: meta(total) });
  globalThis.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
}

function urls(): URL[] {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => new URL(c[0] as string, 'http://localhost')
  );
}

function lastUrl(): URL {
  const all = urls();
  return all[all.length - 1];
}

describe('SupportActivityTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the org’s activity endpoint with page 1 and limit 25, and no grant filter', async () => {
    mockActivity([entry()]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    expect(urls()).toHaveLength(1);
    expect(lastUrl().pathname).toBe('/api/v1/orgs/org-7/support-grants/activity');
    expect(lastUrl().searchParams.get('page')).toBe('1');
    expect(lastUrl().searchParams.get('limit')).toBe('25');
    expect(lastUrl().searchParams.has('grantId')).toBe(false);
  });

  it('renders who, what and the grant each action was taken under', async () => {
    mockActivity([entry()]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent('Vera Vendor');
    expect(row).toHaveTextContent('agent.update');
    expect(row).toHaveTextContent('Support Bot');
    expect(row).toHaveTextContent(`${dateOf('2026-10-16T12:00:00.000Z')}: Ticket 42`);
  });

  it('names a deleted actor "Deleted account"', async () => {
    mockActivity([entry({ actor: null })]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);

    expect(await screen.findByText('Deleted account')).toBeInTheDocument();
  });

  it('words support.enter as "Entered the organisation"', async () => {
    mockActivity([
      entry({ action: 'support.enter', entityType: 'org', entityName: null, entityId: null }),
    ]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);

    expect(await screen.findByText('Entered the organisation')).toBeInTheDocument();
    expect(screen.queryByText('support.enter')).not.toBeInTheDocument();
  });

  it('truncates a long reason to 40 characters in the grant column', async () => {
    mockActivity([entry({ grantId: 'g-2' })]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    const row = screen.getAllByRole('row')[1];
    expect(row).toHaveTextContent(
      `${dateOf('2026-09-01T12:00:00.000Z')}: ${LONG_REASON.slice(0, 40)}…`
    );
    expect(row).not.toHaveTextContent(LONG_REASON);
  });

  it('labels a grant that is not in the props "An earlier grant"', async () => {
    mockActivity([entry({ grantId: 'g-gone' })]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    expect(within(screen.getAllByRole('row')[1]).getByText('An earlier grant')).toBeInTheDocument();
  });

  it('shows the empty state when support has not worked there', async () => {
    mockActivity([]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);

    expect(await screen.findByText('Support has not worked in this organisation.')).toBeVisible();
  });

  it('refetches with grantId and page 1 when a grant is chosen', async () => {
    const user = userEvent.setup();
    mockActivity([entry()], 60);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('1 / 3');

    await user.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => expect(lastUrl().searchParams.get('page')).toBe('2'));
    await screen.findByText('2 / 3');

    await user.click(screen.getByRole('combobox', { name: 'Grant' }));
    await user.click(
      await screen.findByRole('option', {
        name: `${dateOf('2026-09-01T12:00:00.000Z')}: ${LONG_REASON.slice(0, 40)}…`,
      })
    );

    await waitFor(() => expect(lastUrl().searchParams.get('grantId')).toBe('g-2'));
    expect(lastUrl().searchParams.get('page')).toBe('1');
  });

  it('drops grantId again when "All grants" is chosen', async () => {
    const user = userEvent.setup();
    mockActivity([entry()]);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    await user.click(screen.getByRole('combobox', { name: 'Grant' }));
    await user.click(await screen.findByRole('option', { name: /Ticket 42/ }));
    await waitFor(() => expect(lastUrl().searchParams.get('grantId')).toBe('g-1'));

    await user.click(screen.getByRole('combobox', { name: 'Grant' }));
    await user.click(await screen.findByRole('option', { name: 'All grants' }));
    await waitFor(() => expect(lastUrl().searchParams.has('grantId')).toBe(false));
  });

  it('shows an error alert and no rows when the response is not ok', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'What support did could not be loaded. Please try again.'
    );
    expect(screen.queryByText('Vera Vendor')).not.toBeInTheDocument();
    // A failed load must not read as "support never worked here".
    expect(
      screen.queryByText('Support has not worked in this organisation.')
    ).not.toBeInTheDocument();
    expect(screen.getByText('Nothing to show.')).toBeVisible();
  });

  it('shows no pagination when the total fits on one page', async () => {
    mockActivity([entry()], 25);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('Vera Vendor');

    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /previous page/i })).not.toBeInTheDocument();
  });

  it('pages: Next requests page 2, Previous is disabled on page 1', async () => {
    const user = userEvent.setup();
    mockActivity([entry()], 26);
    render(<SupportActivityTable orgId="org-7" grants={GRANTS} />);
    await screen.findByText('1 / 2');

    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /next page/i }));

    await waitFor(() => expect(lastUrl().searchParams.get('page')).toBe('2'));
    expect(await screen.findByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
  });
});
