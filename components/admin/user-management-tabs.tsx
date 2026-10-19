'use client';

/**
 * User Management Tabs Component
 *
 * Client-side tabs wrapper for managing active users and pending invitations.
 * Receives server-side fetched data as props.
 *
 * Tab state is URL-synced via `useUrlTabs` so deep links work
 * (`?tab=invitations`), clicking the sidebar nav resets to the default,
 * and browser back/forward navigates between tabs.
 */

import Link from 'next/link';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';
import { UserTable } from '@/components/admin/user-table';
import { InvitationTable } from '@/components/admin/invitation-table';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import type { UserListItem, InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';

interface UserManagementTabsProps {
  users: UserListItem[];
  usersMeta: PaginationMeta;
  /**
   * Pending invitations, or `null` when they failed to load: the invitations
   * tab then shows a "Couldn't load" notice instead of an empty table, which
   * would read as "none pending". The users tab is unaffected.
   */
  invitations: InvitationListItem[] | null;
  /** Pagination for {@link invitations}; `null` when they failed to load. */
  invitationsMeta: PaginationMeta | null;
}

const ALLOWED_TABS = ['users', 'invitations'] as const;
type UserManagementTab = (typeof ALLOWED_TABS)[number];

export function UserManagementTabs({
  users,
  usersMeta,
  invitations,
  invitationsMeta,
}: UserManagementTabsProps) {
  const { activeTab, setActiveTab } = useUrlTabs<UserManagementTab>({
    defaultTab: 'users',
    allowedTabs: ALLOWED_TABS,
  });

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as UserManagementTab)}
      className="space-y-4"
    >
      <div className="flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="users">
            Active Users
            {usersMeta.total > 0 && (
              <span className="bg-muted-foreground/20 ml-2 rounded-full px-2 py-0.5 text-xs">
                {usersMeta.total}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="invitations">
            Pending Invitations
            {invitationsMeta && invitationsMeta.total > 0 && (
              <span className="bg-muted-foreground/20 ml-2 rounded-full px-2 py-0.5 text-xs">
                {invitationsMeta.total}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
        <Button asChild>
          <Link href="/admin/users/invite">
            <UserPlus className="mr-2 h-4 w-4" />
            Invite User
          </Link>
        </Button>
      </div>

      <TabsContent value="users">
        <UserTable initialUsers={users} initialMeta={usersMeta} hideInviteButton />
      </TabsContent>

      <TabsContent value="invitations">
        {invitations && invitationsMeta ? (
          <InvitationTable initialInvitations={invitations} initialMeta={invitationsMeta} />
        ) : (
          <LoadFailedNotice what="pending invitations" />
        )}
      </TabsContent>
    </Tabs>
  );
}
