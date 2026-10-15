// @vitest-environment happy-dom

/**
 * Admin — Members page (§111 t-813).
 *
 * @see app/admin/members/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/admin-page-viewer', () => ({
  requestActingOrg: vi.fn(),
  requestPrincipal: vi.fn(),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const tableProps = vi.fn();
const formProps = vi.fn();

vi.mock('@/components/admin/members/members-table', () => ({
  MembersTable: (props: unknown) => {
    tableProps(props);
    return <div data-testid="members-table" />;
  },
}));

vi.mock('@/components/admin/members/member-invite-form', () => ({
  MemberInviteForm: (props: unknown) => {
    formProps(props);
    return <div data-testid="invite-form" />;
  },
}));

import MembersPage from '@/app/admin/members/page';
import { requestActingOrg, requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

const MEMBERS = [
  { id: 'u-1', name: 'A', email: 'a@x.test', role: 'OWNER', joinedAt: '2026-01-01T00:00:00.000Z' },
];

function actAs(org: { id: string; name: string } | null) {
  vi.mocked(requestActingOrg).mockResolvedValue(org);
  vi.mocked(requestPrincipal).mockResolvedValue({ principal: { userId: 'u-1' } } as never);
}

describe('MembersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the members of the entered org, names it, and hands roster and viewer to the table', async () => {
    actAs({ id: 'org-entered', name: 'Acme' });
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { members: MEMBERS },
    } as never);

    render(await MembersPage());

    expect(serverFetch).toHaveBeenCalledTimes(1);
    expect(serverFetch).toHaveBeenCalledWith('/api/v1/orgs/org-entered/members');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Members of Acme');
    expect(tableProps).toHaveBeenCalledWith({
      orgId: 'org-entered',
      members: MEMBERS,
      currentUserId: 'u-1',
    });
    expect(formProps).toHaveBeenCalledWith({ orgId: 'org-entered' });
  });

  it('passes a null currentUserId when there is no principal', async () => {
    vi.mocked(requestActingOrg).mockResolvedValue({ id: 'org-entered', name: 'Acme' });
    vi.mocked(requestPrincipal).mockResolvedValue(null);
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { members: MEMBERS },
    } as never);

    render(await MembersPage());

    expect(tableProps).toHaveBeenCalledWith(expect.objectContaining({ currentUserId: null }));
  });

  it('says it is not acting in an organisation and fetches nothing when there is no acting org', async () => {
    actAs(null);

    render(await MembersPage());

    expect(screen.getByText(/not acting in an organisation/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Members$/);
    expect(serverFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('members-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
  });

  it('shows the could-not-be-loaded alert when the fetch is not ok', async () => {
    actAs({ id: 'org-entered', name: 'Acme' });
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await MembersPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('members-table')).not.toBeInTheDocument();
    expect(parseApiResponse).not.toHaveBeenCalled();
  });

  it('shows the alert when the body is unsuccessful', async () => {
    actAs({ id: 'org-entered', name: 'Acme' });
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'X', message: 'x' },
    } as never);

    render(await MembersPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('logs and shows the alert when the fetch throws', async () => {
    actAs({ id: 'org-entered', name: 'Acme' });
    const failure = new Error('network');
    vi.mocked(serverFetch).mockRejectedValue(failure);

    render(await MembersPage());

    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(logger.error).toHaveBeenCalledWith('members page: fetch failed', failure);
  });
});
