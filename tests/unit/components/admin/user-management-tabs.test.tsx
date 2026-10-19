// @vitest-environment happy-dom

/**
 * Tests: UserManagementTabs
 *
 * The invitations are a second tab the page loads separately. When they
 * failed to load (`invitations={null}`), that tab must show a load-failed
 * alert, never an empty table — an empty "Pending Invitations" tab would read
 * as "none pending" (#518). The users tab keeps working.
 *
 * The two tables are mocked to markers: their own behaviour is tested
 * elsewhere, and this file is about which one (or which notice) each tab shows.
 *
 * @see components/admin/user-management-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';

vi.mock('@/components/admin/user-table', () => ({
  UserTable: ({ initialUsers }: { initialUsers: unknown[] }) => (
    <div data-testid="user-table">USERS {initialUsers.length}</div>
  ),
}));

vi.mock('@/components/admin/invitation-table', () => ({
  InvitationTable: ({ initialInvitations }: { initialInvitations: unknown[] }) => (
    <div data-testid="invitation-table">INVITATIONS {initialInvitations.length}</div>
  ),
}));

import { UserManagementTabs } from '@/components/admin/user-management-tabs';
import type { UserListItem, InvitationListItem } from '@/types';

const USER: UserListItem = {
  id: 'u-1',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'USER',
  emailVerified: true,
  image: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};
const INVITATION: InvitationListItem = {
  email: 'new@example.com',
  name: 'New',
  role: 'USER',
  invitedBy: 'u-1',
  invitedByName: 'Ada',
  invitedAt: new Date('2026-10-01T00:00:00.000Z'),
  expiresAt: new Date('2026-10-08T00:00:00.000Z'),
};
const META = (total: number) => ({ page: 1, limit: 20, total, totalPages: 1 });

/** Open the page on a given tab, as `?tab=` would. */
function onTab(tab: 'users' | 'invitations') {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(`tab=${tab}`) as unknown as ReturnType<typeof useSearchParams>
  );
}

describe('UserManagementTabs', () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
  });

  it('shows the invitation table and its count when invitations loaded', () => {
    onTab('invitations');
    render(
      <UserManagementTabs
        users={[USER]}
        usersMeta={META(1)}
        invitations={[INVITATION]}
        invitationsMeta={META(3)}
      />
    );

    expect(screen.getByTestId('invitation-table')).toHaveTextContent('INVITATIONS 1');
    expect(screen.getByRole('tab', { name: /Pending Invitations/ })).toHaveTextContent('3');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ── A failed invitations load is a failure, not "none pending" (#518) ────

  it('shows a load-failed alert in the invitations tab when invitations is null', () => {
    onTab('invitations');
    render(
      <UserManagementTabs
        users={[USER]}
        usersMeta={META(1)}
        invitations={null}
        invitationsMeta={null}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load pending invitations.");
    expect(screen.queryByTestId('invitation-table')).not.toBeInTheDocument();
    // Both tabs are still there to switch between.
    expect(screen.getByRole('tab', { name: /Active Users/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pending Invitations/ })).toBeInTheDocument();
  });

  it('keeps the users tab working when invitations failed to load', () => {
    render(
      <UserManagementTabs
        users={[USER]}
        usersMeta={META(1)}
        invitations={null}
        invitationsMeta={null}
      />
    );

    expect(screen.getByTestId('user-table')).toHaveTextContent('USERS 1');
    expect(screen.getByRole('link', { name: /Invite User/ })).toHaveAttribute(
      'href',
      '/admin/users/invite'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
