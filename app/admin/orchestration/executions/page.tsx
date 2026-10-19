import type { Metadata } from 'next';
import Link from 'next/link';

import { ExecutionsListView } from '@/components/admin/orchestration/executions-list-view';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { cuidSchema, parsePaginationMeta } from '@/lib/validations/common';
import { executionStatusSchema } from '@/lib/validations/orchestration';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
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

/** The list is the page: a failed load throws to the error boundary (#518). */
async function getExecutions(
  workflowId?: string,
  status?: string
): Promise<{ executions: ExecutionListItem[]; meta: PaginationMeta }> {
  const params = new URLSearchParams({ page: '1', limit: '25' });
  if (workflowId) params.set('workflowId', workflowId);
  if (status && status !== 'all') params.set('status', status);
  const { data, meta } = await requireServerData<ExecutionListItem[]>(
    `${API.ADMIN.ORCHESTRATION.EXECUTIONS}?${params.toString()}`
  );
  return { executions: data, meta: parsePaginationMeta(meta) ?? EMPTY_META };
}

/**
 * A panel, for a platform viewer: `null` when it failed, and the view shows
 * a notice in the live-engine cards' place. The cards render a snapshot as
 * counts, so a failed load passed through as zeros would read as "nothing
 * running, nothing orphaned" (#518); the list still renders.
 */
async function getInitialSnapshot(): Promise<LiveEngineSnapshotView | null> {
  const result = await loadServerData<LiveEngineSnapshotView>(
    API.ADMIN.ORCHESTRATION.EXECUTIONS_LIVE_SNAPSHOT
  );
  return result.ok ? result.data : null;
}

/**
 * The URL's filters, with any the API would reject dropped. The list route
 * answers a malformed `workflowId` or an unknown `status` with a 400, and the
 * list is required, so passing one through would make a stale bookmark an
 * error page that "Try again" cannot clear. A dropped filter shows every
 * execution instead, and `dropped` names it so the page can say so.
 */
function parseFilters(params: Record<string, string | string[] | undefined>): {
  workflowId?: string;
  status?: string;
  dropped: string[];
} {
  const workflowId = cuidSchema.safeParse(params.workflowId);
  const status = executionStatusSchema.safeParse(params.status);
  const dropped: string[] = [];
  if (params.workflowId !== undefined && !workflowId.success) dropped.push('workflow');
  // `all` is the status menu's own "no filter", not a bad value.
  if (params.status !== undefined && params.status !== 'all' && !status.success) {
    dropped.push('status');
  }
  return {
    workflowId: workflowId.success ? workflowId.data : undefined,
    status: status.success ? status.data : undefined,
    dropped,
  };
}

export default async function ExecutionsListPage({ searchParams }: PageProps) {
  const { workflowId, status: initialStatus, dropped } = parseFilters(await searchParams);
  // Three parallel reads: executions page, live-engine snapshot, and
  // the settings singleton (for the stuck-step threshold). The
  // snapshot and threshold both feed the dashboard above the table; the
  // page fans them all so the user sees one paint.
  //
  // An org admin (§111 t-812) gets the table alone: the live engine is
  // the platform's, its route refuses them, so its snapshot is not
  // fetched. The threshold still marks stuck-looking rows in their table.
  const viewerTierRead = adminPageViewerTier();
  const [viewerTier, { executions, meta }, snapshot, settings] = await Promise.all([
    viewerTierRead,
    getExecutions(workflowId, initialStatus),
    viewerTierRead.then((tier) => (tier === 'platform' ? getInitialSnapshot() : EMPTY_SNAPSHOT)),
    getOrchestrationSettings(),
  ]);
  const platform = viewerTier === 'platform';

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
            {platform ? (
              <p>
                The cards above the table show in-flight engine state and auto-refresh every 5
                seconds while this tab is in the foreground. The list below shows every execution —
                click any row to inspect the step-by-step trace, or use the row menu to force-fail a
                stuck run.
              </p>
            ) : (
              <p>
                The list shows your organisation&apos;s executions. Click any row to inspect the
                step-by-step trace.
              </p>
            )}
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          {platform ? 'In-flight engine state plus past execution runs.' : 'Past execution runs.'}
        </p>
      </header>

      {dropped.length > 0 && (
        <p role="status" className="bg-muted/40 rounded-md border px-4 py-3 text-sm">
          {dropped.length === 1
            ? `The link's ${dropped[0]} filter isn't valid, so it was ignored.`
            : `The link's ${dropped.join(' and ')} filters aren't valid, so they were ignored.`}{' '}
          Showing all executions.
        </p>
      )}

      <ExecutionsListView
        initialSnapshot={snapshot}
        initialExecutions={executions}
        initialMeta={meta}
        initialWorkflowId={workflowId}
        initialStatus={initialStatus}
        stuckThresholdMins={settings.stuckExecutionThresholdMins}
        viewerTier={viewerTier}
      />
    </div>
  );
}
