'use client';

/**
 * ExecutionsListView — the executions page's client shell.
 *
 * Composes two things that used to live on separate routes:
 *  - `<LiveEngineDashboard>` — auto-refreshing 4-card summary of the
 *    engine's current state, formerly at `/executions/live`.
 *  - `<ExecutionsTable>` — the per-row list (force-fail, lease
 *    inspector, stuck-step column).
 *
 * The cards' "drill into status=X" links become local filter updates
 * via `router.replace` (shallow, no scroll). The table listens for
 * `searchParams.get('status')` changes and refetches — wired up in
 * `ExecutionsTable`'s `useEffect` on `searchParams`. The result: one
 * URL, one paint, both jobs first-class.
 *
 * An org viewer (§111 t-812) gets the table alone: the live-engine cards
 * describe engine state the platform runs for every org, and the row
 * controls act on it, so neither is theirs. Their table lists their own
 * org's executions, as the list route already scopes it.
 *
 * When the page could not load the initial snapshot, `<LoadFailedNotice>`
 * takes the cards' place and the dashboard is not mounted (#518). Mounting
 * it would show the snapshot as counts ("0 running") until its first poll
 * succeeded; the notice's "Try again" re-runs the page's load instead.
 */

import { useCallback, useRef, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  LiveEngineDashboard,
  type LiveEngineSnapshotView,
} from '@/components/admin/orchestration/live-engine-dashboard';
import { ExecutionsTable } from '@/components/admin/orchestration/executions-table';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import type { AdminViewerTier } from '@/lib/auth/admin-tier';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem } from '@/types/orchestration';

export interface ExecutionsListViewProps {
  /**
   * The live-engine snapshot the cards start from. `null` means it failed to
   * load: the cards are replaced by a notice and do not poll.
   */
  initialSnapshot: LiveEngineSnapshotView | null;
  initialExecutions: ExecutionListItem[];
  initialMeta: PaginationMeta;
  initialWorkflowId?: string;
  initialStatus?: string;
  stuckThresholdMins: number;
  /** Who is viewing: an org viewer gets no live-engine cards or row controls. Defaults to the platform. */
  viewerTier?: AdminViewerTier;
}

export function ExecutionsListView({
  initialSnapshot,
  initialExecutions,
  initialMeta,
  initialWorkflowId,
  initialStatus,
  stuckThresholdMins,
  viewerTier = 'platform',
}: ExecutionsListViewProps): ReactElement {
  const platform = viewerTier === 'platform';
  const router = useRouter();
  const searchParams = useSearchParams();
  const tableSectionRef = useRef<HTMLDivElement>(null);

  const handleCardClick = useCallback(
    (status: 'running' | 'pending') => {
      // Update the URL filter in place (shallow). The table listens
      // to `searchParams` and refetches; we do NOT navigate, so
      // there's no page reload and the dashboard's poll timer keeps
      // ticking uninterrupted.
      const params = new URLSearchParams(searchParams.toString());
      params.set('status', status);
      router.replace(`?${params.toString()}`, { scroll: false });
      // The cards live above the table; scroll the table into view
      // so the operator sees the filtered rows immediately rather
      // than having to scroll past the cards.
      tableSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [router, searchParams]
  );

  return (
    <div className="space-y-6">
      {platform &&
        (initialSnapshot ? (
          <LiveEngineDashboard
            initial={initialSnapshot}
            stuckThresholdMins={stuckThresholdMins}
            onCardClick={handleCardClick}
          />
        ) : (
          <LoadFailedNotice what="the live engine snapshot" />
        ))}
      <div ref={tableSectionRef}>
        <ExecutionsTable
          initialExecutions={initialExecutions}
          initialMeta={initialMeta}
          initialWorkflowId={initialWorkflowId}
          initialStatus={initialStatus}
          stuckThresholdMins={stuckThresholdMins}
          engineControls={platform}
        />
      </div>
    </div>
  );
}
