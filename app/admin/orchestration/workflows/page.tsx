import type { Metadata } from 'next';
import Link from 'next/link';

import { WorkflowsTable } from '@/components/admin/orchestration/workflows-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiWorkflowListItem } from '@/types/orchestration';
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
async function getWorkflows(): Promise<{
  workflows: AiWorkflowListItem[];
  meta: PaginationMeta;
  error: string | null;
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?page=1&limit=25`);
    if (!res.ok) return { workflows: [], meta: EMPTY_META, error: 'Failed to load workflows' };
    const body = await parseApiResponse<AiWorkflowListItem[]>(res);
    if (!body.success)
      return { workflows: [], meta: EMPTY_META, error: 'Failed to load workflows' };
    return {
      workflows: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
      error: null,
    };
  } catch (err) {
    logger.error('workflows list page: initial fetch failed', err);
    return { workflows: [], meta: EMPTY_META, error: 'Failed to load workflows' };
  }
}

export default async function WorkflowsListPage() {
  const { workflows, meta, error } = await getWorkflows();

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
        <h1 className="text-2xl font-semibold">
          Workflows{' '}
          <FieldHelp title="What are workflows?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              A workflow is a multi-step AI pipeline that chains prompts, agent calls, routing
              logic, and evaluation gates into a directed graph. Instead of a single agent answering
              one question, a workflow orchestrates several steps — each feeding its output to the
              next.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              You design workflows visually using the builder canvas. Pattern blocks (prompt, chain,
              route, evaluate, etc.) are connected into a DAG. At runtime the engine walks the graph
              step by step, tracking tokens, cost, and errors at each stage.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Create, validate, and launch workflows. Click a workflow to open the visual builder.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Design, validate, and run multi-step AI workflows built from pattern blocks.
        </p>
      </header>

      <WorkflowsTable initialWorkflows={workflows} initialMeta={meta} initialError={error} />
    </div>
  );
}
