import type { Metadata } from 'next';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
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
  try {
    const res = await serverFetch(
      API.USERS.LIST + `?limit=${DEFAULT_PAGE_LIMIT}&sortBy=createdAt&sortOrder=desc`
    );

    if (!res.ok) {
      return {
        users: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    const data = await parseApiResponse<UserListItem[]>(res);

    if (!data.success) {
      return {
        users: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    // Convert string dates to Date objects
    const users: UserListItem[] = data.data.map((user) => ({
      ...user,
      createdAt: new Date(user.createdAt),
    }));

    return {
      users,
      meta: (data.meta as PaginationMeta) || {
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        total: users.length,
        totalPages: 1,
      },
    };
  } catch {
    return {
      users: [],
      meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
    };
  }
}

/**
 * Fetch pending invitations from API
 */
async function getInvitations(): Promise<{
  invitations: InvitationListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(
      API.ADMIN.INVITATIONS + `?limit=${DEFAULT_PAGE_LIMIT}&sortBy=invitedAt&sortOrder=desc`
    );

    if (!res.ok) {
      return {
        invitations: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    const data = await parseApiResponse<InvitationListItem[]>(res);

    if (!data.success) {
      return {
        invitations: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    // Convert string dates to Date objects
    const invitations: InvitationListItem[] = data.data.map((inv) => ({
      ...inv,
      invitedAt: new Date(inv.invitedAt),
      expiresAt: new Date(inv.expiresAt),
    }));

    return {
      invitations,
      meta: (data.meta as PaginationMeta) || {
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        total: invitations.length,
        totalPages: 1,
      },
    };
  } catch {
    return {
      invitations: [],
      meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
    };
  }
}

/**
 * Admin Users Page (Phase 4.4)
 *
 * User management with tabs for active users and pending invitations.
 */
export default async function AdminUsersPage() {
  // Fetch both data sets in parallel for performance
  const [{ users, meta: usersMeta }, { invitations, meta: invitationsMeta }] = await Promise.all([
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
        invitations={invitations}
        invitationsMeta={invitationsMeta}
      />
    </div>
  );
}
