import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { UserManagementTabs } from '@/components/admin/user-management-tabs';
import type { UserListItem, InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Users',
  description: 'Manage user accounts and invitations',
};

interface UsersResponse {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  emailVerified: boolean;
  createdAt: string;
}

interface UsersApiResponse {
  success: boolean;
  data: UsersResponse[];
  meta?: PaginationMeta;
}

interface InvitationsResponse {
  email: string;
  name: string;
  role: string;
  invitedBy: string;
  invitedByName: string | null;
  invitedAt: string;
  expiresAt: string;
}

interface InvitationsApiResponse {
  success: boolean;
  data: InvitationsResponse[];
  meta?: PaginationMeta;
}

/**
 * Get cookies header for API requests
 */
async function getCookieHeader(): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Fetch users from API
 */
async function getUsers(): Promise<{
  users: UserListItem[];
  meta: PaginationMeta;
}> {
  try {
    const cookieHeader = await getCookieHeader();

    const res = await fetch(
      `${process.env.BETTER_AUTH_URL || 'http://localhost:3000'}/api/v1/users?limit=20&sortBy=createdAt&sortOrder=desc`,
      {
        headers: {
          Cookie: cookieHeader,
        },
        cache: 'no-store',
      }
    );

    if (!res.ok) {
      return {
        users: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    }

    const data = (await res.json()) as UsersApiResponse;

    if (!data.success) {
      return {
        users: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    }

    // Convert string dates to Date objects
    const users: UserListItem[] = data.data.map((user) => ({
      ...user,
      createdAt: new Date(user.createdAt),
    }));

    return {
      users,
      meta: data.meta || { page: 1, limit: 20, total: users.length, totalPages: 1 },
    };
  } catch {
    return {
      users: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
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
    const cookieHeader = await getCookieHeader();

    const res = await fetch(
      `${process.env.BETTER_AUTH_URL || 'http://localhost:3000'}/api/v1/admin/invitations?limit=20&sortBy=invitedAt&sortOrder=desc`,
      {
        headers: {
          Cookie: cookieHeader,
        },
        cache: 'no-store',
      }
    );

    if (!res.ok) {
      return {
        invitations: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      };
    }

    const data = (await res.json()) as InvitationsApiResponse;

    if (!data.success) {
      return {
        invitations: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
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
      meta: data.meta || { page: 1, limit: 20, total: invitations.length, totalPages: 1 },
    };
  } catch {
    return {
      invitations: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
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
