import type { Metadata } from 'next';
import Link from 'next/link';

import { WorkflowsTable } from '@/components/admin/orchestration/workflows-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiWorkflow } from '@/types/prisma';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Workflows · AI Orchestration',
  description: 'Design, validate and run multi-step AI workflows.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

/**
 * Admin — Workflows list page (Phase 5 Session 5.1a).
 *
 * Server shell that pre-renders the first page of workflows via
 * `serverFetch` and hands the result to `<WorkflowsTable>` for
 * client-side search / sort / pagination / mutations. Fetch failures
 * never throw — the table renders an empty-state banner.
 */
async function getWorkflows(): Promise<{ workflows: AiWorkflow[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?page=1&limit=25`);
    if (!res.ok) return { workflows: [], meta: EMPTY_META };
    const body = await parseApiResponse<AiWorkflow[]>(res);
    if (!body.success) return { workflows: [], meta: EMPTY_META };
    return {
      workflows: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('workflows list page: initial fetch failed', err);
    return { workflows: [], meta: EMPTY_META };
  }
}

export default async function WorkflowsListPage() {
  const { workflows, meta } = await getWorkflows();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Workflows</span>
        </nav>
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="text-muted-foreground text-sm">
          Design, validate, and run multi-step AI workflows built from pattern blocks.
        </p>
      </header>

      <WorkflowsTable initialWorkflows={workflows} initialMeta={meta} />
    </div>
  );
}
