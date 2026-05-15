'use client';

/**
 * ApprovalsTabs — switches the approvals page between the live pending
 * queue and a historical decision log. The pending list is server-seeded
 * (via `ApprovalsTable` props) and the history list self-fetches on
 * mount, so swapping tabs after the first paint doesn't refetch the
 * pending data.
 */

import type { ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApprovalsTable } from '@/components/admin/orchestration/approvals-table';
import { ApprovalsHistoryTable } from '@/components/admin/orchestration/approvals-history-table';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

interface Props {
  initialApprovals: ExecutionListItem[];
  initialMeta: PaginationMeta;
}

export function ApprovalsTabs({ initialApprovals, initialMeta }: Props): ReactElement {
  return (
    <Tabs defaultValue="pending" className="space-y-4">
      <TabsList>
        <TabsTrigger value="pending">
          Pending
          {initialMeta.total > 0 && (
            <Badge variant="secondary" className="ml-2 px-1.5 text-[10px]">
              {initialMeta.total}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      {/* forceMount keeps ApprovalsTable mounted when the user switches
          to History — without this, Radix unmounts the inactive panel,
          throwing away the local state that tracks just-approved /
          just-rejected rows. Returning to Pending would then re-init
          from `initialApprovals` (the stale server snapshot) and the
          decided row would reappear. `hidden` is applied automatically
          by Radix when state=inactive, so the panel is invisible but
          its React state survives. */}
      <TabsContent value="pending" forceMount>
        <ApprovalsTable initialApprovals={initialApprovals} initialMeta={initialMeta} />
      </TabsContent>
      <TabsContent value="history">
        <ApprovalsHistoryTable />
      </TabsContent>
    </Tabs>
  );
}
