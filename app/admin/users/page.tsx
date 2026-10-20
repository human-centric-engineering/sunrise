import type { Metadata } from 'next';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { parsePaginationMeta } from '@/lib/validations/common';
import { UserManagementTabs } from '@/components/admin/user-management-tabs';
import type { UserListItem, InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

/** Default pagination limit for users and invitations tables */
const DEFAULT_PAGE_LIMIT = 20;

export const metadata: Metadata = {
  title: 'Users',
  description: 'Manage user accounts and invitations',
};

/**
 * Fetch users from API
 */
async function getUsers(): Promise<{
  users: UserListItem[];
  meta: PaginationMeta;
}> {
  const { data, meta } = await requireServerData<UserListItem[]>(
    API.USERS.LIST + `?limit=${DEFAULT_PAGE_LIMIT}&sortBy=createdAt&sortOrder=desc`
  );

  // Convert string dates to Date objects
  const users: UserListItem[] = data.map((user) => ({
    ...user,
    createdAt: new Date(user.createdAt),
    erasureRequestedAt: user.erasureRequestedAt ? new Date(user.erasureRequestedAt) : null,
  }));

  return {
    users,
    meta: parsePaginationMeta(meta) ?? {
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total: users.length,
      totalPages: 1,
    },
  };
}

/**
 * Fetch pending invitations from API. `null` when they failed to load: the
 * failure is logged by `loadServerData`, and the invitations tab shows it.
 */
async function getInvitations(): Promise<{
  invitations: InvitationListItem[];
  meta: PaginationMeta;
} | null> {
  const result = await loadServerData<InvitationListItem[]>(
    API.ADMIN.INVITATIONS + `?limit=${DEFAULT_PAGE_LIMIT}&sortBy=invitedAt&sortOrder=desc`
  );
  if (!result.ok) return null;
  const { data, meta } = result;

  // Convert string dates to Date objects
  const invitations: InvitationListItem[] = data.map((inv) => ({
    ...inv,
    invitedAt: new Date(inv.invitedAt),
    expiresAt: new Date(inv.expiresAt),
  }));

  return {
    invitations,
    meta: parsePaginationMeta(meta) ?? {
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total: invitations.length,
      totalPages: 1,
    },
  };
}

/**
 * Admin Users Page (Phase 4.4)
 *
 * User management with tabs for active users and pending invitations.
 *
 * A failed load of the users throws to the admin error boundary rather than
 * rendering "No users found" (#518). The invitations are the second tab: a
 * failed load there passes `null`, and that tab alone shows a "Couldn't load"
 * notice — never an empty tab, which would read as "none pending".
 */
export default async function AdminUsersPage() {
  // Fetch both data sets in parallel for performance
  const [{ users, meta: usersMeta }, invitationsLoad] = await Promise.all([
    getUsers(),
    getInvitations(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">User Management</h2>
        <p className="text-muted-foreground text-sm">
          View, edit, and manage user accounts and invitations.
        </p>
      </div>

      <UserManagementTabs
        users={users}
        usersMeta={usersMeta}
        invitations={invitationsLoad?.invitations ?? null}
        invitationsMeta={invitationsLoad?.meta ?? null}
      />
    </div>
  );
}
