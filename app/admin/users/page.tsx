import type { Metadata } from 'next';
import { UserManagementTabs } from '@/components/admin/user-management-tabs';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getAllPendingInvitations } from '@/lib/utils/invitation-token';
import type { UserListItem, InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

/** Default pagination limit for users and invitations tables */
const DEFAULT_PAGE_LIMIT = 20;

export const metadata: Metadata = {
  title: 'Users',
  description: 'Manage user accounts and invitations',
};

/**
 * Admin Users Page (Phase 4.4)
 *
 * User management with tabs for active users and pending invitations.
 */
export default async function AdminUsersPage() {
  let users: UserListItem[] = [];
  let usersMeta: PaginationMeta = { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 };
  let invitations: InvitationListItem[] = [];
  let invitationsMeta: PaginationMeta = {
    page: 1,
    limit: DEFAULT_PAGE_LIMIT,
    total: 0,
    totalPages: 0,
  };

  try {
    const [usersResult, invResult] = await Promise.all([
      Promise.all([
        prisma.user.findMany({
          take: DEFAULT_PAGE_LIMIT,
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
            emailVerified: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.user.count(),
      ]),
      getAllPendingInvitations({
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        sortBy: 'invitedAt',
        sortOrder: 'desc',
      }),
    ]);

    const [rawUsers, totalUsers] = usersResult;
    users = rawUsers as UserListItem[];
    usersMeta = {
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total: totalUsers,
      totalPages: Math.ceil(totalUsers / DEFAULT_PAGE_LIMIT),
    };

    invitations = invResult.invitations as InvitationListItem[];
    invitationsMeta = {
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total: invResult.total,
      totalPages: Math.ceil(invResult.total / DEFAULT_PAGE_LIMIT),
    };
  } catch (err) {
    logger.error('admin users page: fetch failed', err);
  }

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
