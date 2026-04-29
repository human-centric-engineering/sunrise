import type { Metadata } from 'next';
import Link from 'next/link';

import { ApprovalsTable } from '@/components/admin/orchestration/approvals-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Approval Queue · AI Orchestration',
  description: 'Review and approve or reject paused workflow executions.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

async function getPendingApprovals(): Promise<{
  approvals: ExecutionListItem[];
  meta: PaginationMeta;
}> {
  try {
    const params = new URLSearchParams({
      page: '1',
      limit: '25',
      status: 'paused_for_approval',
    });
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?${params.toString()}`);
    if (!res.ok) return { approvals: [], meta: EMPTY_META };
    const body = await parseApiResponse<ExecutionListItem[]>(res);
    if (!body.success) return { approvals: [], meta: EMPTY_META };
    return {
      approvals: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('approvals list page: initial fetch failed', err);
    return { approvals: [], meta: EMPTY_META };
  }
}

export default async function ApprovalQueuePage() {
  const { approvals, meta } = await getPendingApprovals();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Approval Queue</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Approval Queue{' '}
          <FieldHelp
            title="What is the approval queue?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              Workflows with a <strong>human_approval</strong> step pause execution and wait for an
              admin to review and approve or reject before continuing.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Lists all paused executions awaiting your decision. Expand a row to see context, then
              approve with optional notes or reject with a reason.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Review and approve or reject paused workflow executions.
        </p>
      </header>

      <ApprovalsTable initialApprovals={approvals} initialMeta={meta} />
    </div>
  );
}
