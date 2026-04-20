import type { Metadata } from 'next';
import Link from 'next/link';

import { ExecutionsTable } from '@/components/admin/orchestration/executions-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Executions · AI Orchestration',
  description: 'Browse and inspect past workflow executions.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

export interface ExecutionListItem {
  id: string;
  workflowId: string;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  createdAt: string;
  completedAt: string | null;
  workflow: { id: string; name: string };
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function getExecutions(
  workflowId?: string
): Promise<{ executions: ExecutionListItem[]; meta: PaginationMeta }> {
  try {
    const params = new URLSearchParams({ page: '1', limit: '25' });
    if (workflowId) params.set('workflowId', workflowId);
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?${params.toString()}`);
    if (!res.ok) return { executions: [], meta: EMPTY_META };
    const body = await parseApiResponse<ExecutionListItem[]>(res);
    if (!body.success) return { executions: [], meta: EMPTY_META };
    return {
      executions: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('executions list page: initial fetch failed', err);
    return { executions: [], meta: EMPTY_META };
  }
}

export default async function ExecutionsListPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const workflowId =
    typeof resolvedParams.workflowId === 'string' ? resolvedParams.workflowId : undefined;
  const { executions, meta } = await getExecutions(workflowId);

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Executions</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Executions{' '}
          <FieldHelp title="What are executions?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              An execution is a single run of a workflow. It records every step the engine processed
              — inputs, outputs, tokens, cost, and errors.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Browse past runs, filter by workflow or status, and click any row to inspect the
              step-by-step trace.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Browse and inspect past workflow execution runs.
        </p>
      </header>

      <ExecutionsTable
        initialExecutions={executions}
        initialMeta={meta}
        initialWorkflowId={workflowId}
      />
    </div>
  );
}
