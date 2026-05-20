'use client';

/**
 * Live engine dashboard — four cards summarising the orchestration
 * engine's current state. Polled every 5 s while the admin tab is
 * visible (see `useAutoRefresh`).
 *
 * Cards:
 *  - Running     : count + p95 age of current step (oldest branch wins)
 *  - Queued      : pending count + how long the oldest has been waiting
 *  - Orphaned    : running rows whose lease has expired (subset of running)
 *  - Providers   : per-provider in-flight call count from the in-process counter
 *
 * Each card links to the executions list filtered to the matching
 * status so operators can drill in. The provider card has no drill-in
 * because counts are in-memory only.
 */

import Link from 'next/link';
import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, Clock, Gauge, ServerCog } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAutoRefresh } from '@/lib/hooks/use-auto-refresh';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';

export interface LiveEngineSnapshotView {
  running: {
    count: number;
    p95AgeMs: number | null;
    maxAgeMs: number | null;
  };
  queued: {
    count: number;
    maxWaitMs: number | null;
  };
  orphaned: {
    count: number;
  };
  providers: { provider: string; inFlight: number }[];
  generatedAt: string;
}

export interface LiveEngineDashboardProps {
  initial: LiveEngineSnapshotView;
  /**
   * Stuck-step threshold from settings (minutes). Used purely for the
   * card's "Stuck threshold: Nm" hint copy on the Running card — the
   * actual highlighting lives on the executions list. Falls back to
   * 5 if missing.
   */
  stuckThresholdMins?: number;
  /**
   * Poll interval. Default 5 s. Configurable so tests can drive the
   * timer without waiting wall-clock seconds.
   */
  pollIntervalMs?: number;
  /**
   * Optional click handler for the three drill-in cards (Running,
   * Queued, Orphaned). When provided, cards render as buttons that
   * call the handler with the matching `status` value — used on the
   * executions page where the cards sit above the list and clicking
   * should update the filter in-place rather than navigate. When
   * omitted, cards render as `<Link>` to `/executions?status=...`
   * (used by any caller that embeds the dashboard outside the list).
   */
  onCardClick?: (status: 'running' | 'pending') => void;
}

const DEFAULT_POLL_MS = 5_000;

export function LiveEngineDashboard({
  initial,
  stuckThresholdMins = 5,
  pollIntervalMs = DEFAULT_POLL_MS,
  onCardClick,
}: LiveEngineDashboardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<LiveEngineSnapshotView>(initial);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>(new Date(initial.generatedAt));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.EXECUTIONS_LIVE_SNAPSHOT, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await parseApiResponse<LiveEngineSnapshotView>(res);
      if (!body.success) throw new Error('parse failed');
      setSnapshot(body.data);
      setLastUpdatedAt(new Date(body.data.generatedAt));
      setError(null);
    } catch (err) {
      // Keep the last good snapshot on screen; surface a small banner
      // so operators know the numbers may be stale. The dashboard does
      // not throw — a transient blip mid-poll should not crash the page.
      setError(err instanceof Error ? err.message : 'refresh failed');
    }
  }, []);

  useAutoRefresh(refresh, pollIntervalMs);

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          Live snapshot refresh failed — showing last good values. ({error})
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <DrillInCard
          href={`/admin/orchestration/executions?status=running`}
          onClick={onCardClick ? () => onCardClick('running') : undefined}
          icon={<Gauge className="h-5 w-5" aria-hidden />}
          title="Running"
          primary={snapshot.running.count.toLocaleString()}
          secondary={
            snapshot.running.count === 0
              ? 'No executions in flight'
              : `p95 step age ${formatMs(snapshot.running.p95AgeMs)} · max ${formatMs(snapshot.running.maxAgeMs)}`
          }
          hint={`Stuck threshold: ${stuckThresholdMins}m`}
        />
        <DrillInCard
          href={`/admin/orchestration/executions?status=pending`}
          onClick={onCardClick ? () => onCardClick('pending') : undefined}
          icon={<Clock className="h-5 w-5" aria-hidden />}
          title="Queued"
          primary={snapshot.queued.count.toLocaleString()}
          secondary={
            snapshot.queued.count === 0
              ? 'Nothing waiting to start'
              : `Oldest wait: ${formatMs(snapshot.queued.maxWaitMs)}`
          }
        />
        <DrillInCard
          href={`/admin/orchestration/executions?status=running`}
          onClick={onCardClick ? () => onCardClick('running') : undefined}
          icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
          title="Orphaned"
          primary={snapshot.orphaned.count.toLocaleString()}
          secondary={
            snapshot.orphaned.count === 0
              ? 'All leases healthy'
              : 'Running rows whose lease has expired'
          }
          variant={snapshot.orphaned.count > 0 ? 'warning' : 'default'}
        />
        <ProviderCard providers={snapshot.providers} />
      </div>

      <p className="text-muted-foreground text-xs">
        Last refreshed {lastUpdatedAt.toLocaleTimeString()} · auto-refreshes every{' '}
        {Math.round(pollIntervalMs / 1000)} s while this tab is in the foreground.
      </p>
    </div>
  );
}

interface DrillInCardProps {
  href: string;
  /**
   * When provided, the card is rendered as a `<button>` and the
   * handler is invoked on click — used when the dashboard is embedded
   * on the executions page and clicks should update the filter in
   * place rather than navigate. When omitted, the card renders as a
   * `<Link href={href}>` and behaves as a route.
   */
  onClick?: () => void;
  icon: ReactNode;
  title: string;
  primary: string;
  secondary: string;
  hint?: string;
  variant?: 'default' | 'warning';
}

function DrillInCard({
  href,
  onClick,
  icon,
  title,
  primary,
  secondary,
  hint,
  variant = 'default',
}: DrillInCardProps): ReactElement {
  // `h-full` on every layer keeps all four grid cells the same
  // height regardless of content. Without it the Provider in-flight
  // card grows with its list and the other three sit at their
  // shorter natural height, leaving uneven whitespace below them.
  // The grid stretches the cell; the wrapper, Card, and CardContent
  // must each take that full height for it to propagate down.
  const wrapperClassName =
    'group focus-visible:ring-ring h-full rounded-lg focus-visible:ring-2 focus-visible:outline-none';
  const cardBody = (
    <Card
      className={
        variant === 'warning'
          ? 'h-full border-amber-300 transition-shadow hover:shadow-md dark:border-amber-700'
          : 'h-full transition-shadow hover:shadow-md'
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </CardTitle>
        <ArrowUpRight className="text-muted-foreground h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums">{primary}</div>
        <p className="text-muted-foreground mt-1 text-xs">{secondary}</p>
        {hint && <p className="text-muted-foreground mt-1 text-xs italic">{hint}</p>}
      </CardContent>
    </Card>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        // Stable accessible name = card title only. Without it the
        // computed name pulls in the secondary copy too — and
        // "Orphaned" cards say "Running rows whose lease has expired"
        // in that copy, which would make `getByRole('button', { name:
        // /running/i })` ambiguous in tests and confusing for screen
        // readers.
        aria-label={title}
        className={`${wrapperClassName} block w-full text-left`}
      >
        {cardBody}
      </button>
    );
  }
  return (
    <Link href={href} aria-label={title} className={wrapperClassName}>
      {cardBody}
    </Link>
  );
}

function ProviderCard({
  providers,
}: {
  providers: { provider: string; inFlight: number }[];
}): ReactElement {
  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
          <ServerCog className="h-5 w-5" aria-hidden />
          Provider in-flight
        </CardTitle>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <>
            <div className="text-3xl font-semibold tabular-nums">0</div>
            <p className="text-muted-foreground mt-1 text-xs">No active provider calls.</p>
          </>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {providers.map((p) => (
              <li key={p.provider} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">{p.provider}</span>
                <Badge variant={p.inFlight > 10 ? 'destructive' : 'secondary'} className="text-xs">
                  {p.inFlight}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Render a duration in the most operator-readable unit. Sub-second
 * gets the millisecond count (useful when the queue is empty and the
 * "max wait" is a few hundred ms); seconds and minutes round to whole
 * units to keep the card legible.
 */
function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
