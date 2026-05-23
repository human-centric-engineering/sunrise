import type { Metadata } from 'next';
import Link from 'next/link';

import { ExecutionsListView } from '@/components/admin/orchestration/executions-list-view';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { logger } from '@/lib/logging';
import type { LiveEngineSnapshotView } from '@/components/admin/orchestration/live-engine-dashboard';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Executions · AI Orchestration',
  description:
    'In-flight engine state plus past workflow execution runs. Counts auto-refresh while this tab is in the foreground.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

const EMPTY_SNAPSHOT: LiveEngineSnapshotView = {
  running: { count: 0, p95AgeMs: null, maxAgeMs: null },
  queued: { count: 0, maxWaitMs: null },
  orphaned: { count: 0 },
  providers: [],
  generatedAt: new Date(0).toISOString(),
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function getExecutions(
  workflowId?: string,
  status?: string
): Promise<{ executions: ExecutionListItem[]; meta: PaginationMeta }> {
  try {
    const params = new URLSearchParams({ page: '1', limit: '25' });
    if (workflowId) params.set('workflowId', workflowId);
    if (status && status !== 'all') params.set('status', status);
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

async function getInitialSnapshot(): Promise<LiveEngineSnapshotView> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.EXECUTIONS_LIVE_SNAPSHOT);
    if (!res.ok) return EMPTY_SNAPSHOT;
    const body = await parseApiResponse<LiveEngineSnapshotView>(res);
    if (!body.success) return EMPTY_SNAPSHOT;
    return body.data;
  } catch (err) {
    logger.error('executions list page: snapshot fetch failed', err);
    return EMPTY_SNAPSHOT;
  }
}

export default async function ExecutionsListPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const workflowId =
    typeof resolvedParams.workflowId === 'string' ? resolvedParams.workflowId : undefined;
  const initialStatus =
    typeof resolvedParams.status === 'string' ? resolvedParams.status : undefined;
  // Three parallel reads: executions page, live-engine snapshot, and
  // the settings singleton (for the stuck-step threshold). The
  // snapshot and threshold are both required by the dashboard above
  // the table; the page fans them all so the user sees one paint.
  const [{ executions, meta }, snapshot, settings] = await Promise.all([
    getExecutions(workflowId, initialStatus),
    getInitialSnapshot(),
    getOrchestrationSettings(),
  ]);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Executions</span>
      </nav>
      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">
          Executions{' '}
          <FieldHelp title="What are executions?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              An execution is a single run of a workflow. It records every step the engine processed
              — inputs, outputs, tokens, cost, and errors.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              The cards above the table show in-flight engine state and auto-refresh every 5 seconds
              while this tab is in the foreground. The list below shows every execution — click any
              row to inspect the step-by-step trace, or use the row menu to force-fail a stuck run.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          In-flight engine state plus past execution runs.
        </p>
      </header>

      <ExecutionsListView
        initialSnapshot={snapshot}
        initialExecutions={executions}
        initialMeta={meta}
        initialWorkflowId={workflowId}
        initialStatus={initialStatus}
        stuckThresholdMins={settings.stuckExecutionThresholdMins}
      />
    </div>
  );
}
