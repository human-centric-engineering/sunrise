import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { UserTable } from '@/components/admin/user-table';
import type { UserListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Users',
  description: 'Manage user accounts',
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

/**
 * Fetch users from API
 */
async function getUsers(): Promise<{
  users: UserListItem[];
  meta: PaginationMeta;
}> {
  try {
    // Get cookies to forward to the API
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

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
 * Admin Users Page (Phase 4.4)
 *
 * User management with table, search, and actions.
 */
export default async function AdminUsersPage() {
  const { users, meta } = await getUsers();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">User Management</h2>
        <p className="text-muted-foreground text-sm">View, edit, and manage user accounts.</p>
      </div>

      <UserTable initialUsers={users} initialMeta={meta} />
    </div>
  );
}
