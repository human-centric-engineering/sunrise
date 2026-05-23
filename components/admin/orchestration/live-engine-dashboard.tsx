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
import { AlertTriangle, Clock, Gauge, ServerCog } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
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

      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold">Live engine</h2>
        <FieldHelp
          title="What does 'stuck' mean?"
          contentClassName="w-[26rem] max-h-[28rem] overflow-y-auto"
          ariaLabel="What does stuck mean"
        >
          <p>
            A running execution whose current step has been in flight longer than the{' '}
            <strong>stuck threshold</strong> (currently {stuckThresholdMins} minute
            {stuckThresholdMins === 1 ? '' : 's'}, set in{' '}
            <Link
              href="/admin/orchestration/settings#stuckExecutionThresholdMins"
              className="text-foreground underline"
            >
              Settings → Limits
            </Link>
            ). Stuck rows get an amber background and a ⚠ in the <em>Step age</em> column of the
            list below.
          </p>
          <p className="mt-2">
            <strong>The threshold is a visibility flag, not a processing rule.</strong> The engine
            does not auto-fail, cancel, retry, or time out a row that crosses it. LLM calls keep
            streaming, external HTTP steps keep waiting, approval steps keep waiting on humans.
            Force-fail is a separate manual action on the row menu.
          </p>

          <p className="text-foreground mt-3 font-medium">How executions get stuck</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              A provider call hangs — e.g. an OpenAI request that exceeded its HTTP timeout but the
              connection is still open.
            </li>
            <li>An external HTTP step is waiting on a slow vendor API.</li>
            <li>
              A <code>paused_for_approval</code> step is waiting on a human in the Approvals queue.
            </li>
            <li>
              The worker driving the run crashed mid-step (deploy, OOM, process exit). These also
              show as <strong>Orphaned</strong>; the engine sweeps and re-claims them every ~60s.
            </li>
            <li>
              The workflow genuinely takes that long — long RAG retrievals, large embeddings,
              multi-step LLM chains. If this is normal for your workflows, raise the threshold in{' '}
              <Link
                href="/admin/orchestration/settings#stuckExecutionThresholdMins"
                className="text-foreground underline"
              >
                Settings → Limits
              </Link>
              .
            </li>
          </ul>

          <p className="text-foreground mt-3 font-medium">How to get an execution unstuck</p>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              Click the row → <strong>View trace</strong> to see which step is hanging and why.
            </li>
            <li>
              If a human approval is pending → action it on the <strong>Approvals</strong> page.
            </li>
            <li>
              If the row is <strong>Orphaned</strong> → wait ~60s for the sweep to re-claim it, or
              force-fail.
            </li>
            <li>
              If it is genuinely hung → row menu → <strong>Force fail</strong>. This sets{' '}
              <code>status=failed</code> immediately, emits the <code>workflow.failed</code> and{' '}
              <code>execution.force_failed</code> hooks, and records the action with your reason in
              the admin audit log. It does <strong>not</strong> roll back side-effects that already
              ran (external API calls made, notifications sent).
            </li>
          </ol>
        </FieldHelp>
      </div>

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
          info={
            <>
              <p>
                Executions the engine is driving right now. The age numbers (p95 / max) measure time
                spent in the <em>current</em> step, not total run time. For a parallel fan-out, the
                oldest in-flight branch wins so the number reflects &quot;how long has this been
                waiting&quot;, not &quot;how recently did something happen&quot;.
              </p>
              <p className="mt-2">
                Rows past the stuck threshold ({stuckThresholdMins}m, set in{' '}
                <Link
                  href="/admin/orchestration/settings#stuckExecutionThresholdMins"
                  className="text-foreground underline"
                >
                  Settings → Limits
                </Link>
                ) are highlighted amber in the list below. They are flagged for your attention, not
                auto-failed — use the row menu to <strong>View trace</strong> or{' '}
                <strong>Force fail</strong>.
              </p>
              <p className="mt-2">
                Example: p95 = 12s, max = 47s on a chat workflow → healthy. p95 = 4m, max = 18m on
                the same workflow → something is hanging; check the longest row.
              </p>
            </>
          }
        />
        <DrillInCard
          href={`/admin/orchestration/executions?status=pending`}
          onClick={onCardClick ? () => onCardClick('pending') : undefined}
          icon={<Clock className="h-5 w-5" aria-hidden />}
          title="Pending"
          primary={snapshot.queued.count.toLocaleString()}
          secondary={
            snapshot.queued.count === 0
              ? 'Nothing waiting to start'
              : `Oldest wait: ${formatMs(snapshot.queued.maxWaitMs)}`
          }
          info={
            <>
              <p>
                Executions triggered but not yet picked up by the engine.{' '}
                <strong>Steady state should be 0</strong> — workflows are normally claimed within a
                tick of being created.
              </p>
              <p className="mt-2">A sustained non-zero count usually means one of:</p>
              <ul className="ml-4 list-disc space-y-1">
                <li>The engine worker is not running (check the process).</li>
                <li>A burst is queuing behind currently-running work.</li>
                <li>Engine concurrency is set too low for current volume.</li>
              </ul>
              <p className="mt-2">
                <em>Oldest wait</em> shows how long the longest-waiting row has been queued. A few
                hundred ms is normal; minutes is not.
              </p>
            </>
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
              ? 'No orphaned executions'
              : 'Running rows with no live worker'
          }
          variant={snapshot.orphaned.count > 0 ? 'warning' : 'default'}
          info={
            <>
              <p>
                When a worker picks up an execution it acquires a <strong>lease</strong> — a
                time-limited claim it renews while it&apos;s actively driving the run. If the worker
                dies or stops responding, the lease stops renewing and expires; the row then shows
                here as orphaned.
              </p>
              <p className="mt-2">
                Common causes: deploy rollover, OOM kill, process crash, network partition.
              </p>
              <p className="mt-2">
                The maintenance sweep re-claims these every ~60s, so a brief blip during a deploy is
                expected and self-heals. A <strong>persistent</strong> non-zero count means either
                the sweep is not running, or runs are crashing faster than recovery can keep up —
                check worker logs.
              </p>
              <p className="mt-2">
                To inspect one: open the row in the list below, then row menu →{' '}
                <strong>View lease</strong> to see the lease event history (claim, renew, expire).
              </p>
            </>
          }
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
  /**
   * Body of the (i) popover — explains what the card's count means
   * and when an operator should worry. Rendered as a sibling of the
   * card's clickable wrapper (not a child) because FieldHelp's
   * trigger is itself a `<button>` and nested buttons are invalid
   * HTML. Absolute positioning + a `relative` grid cell wrapper
   * floats the trigger over the top-right corner of the card.
   */
  info: ReactNode;
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
  info,
}: DrillInCardProps): ReactElement {
  // `h-full` on every layer keeps all four grid cells the same height
  // regardless of content (see the ProviderCard which grows with its
  // list — without h-full propagation the other three cards shrink
  // to their natural height and leave whitespace below).
  const wrapperClassName =
    'focus-visible:ring-ring h-full rounded-lg focus-visible:ring-2 focus-visible:outline-none';
  const cardBody = (
    <Card
      className={
        variant === 'warning'
          ? 'h-full cursor-pointer border-amber-300 transition-shadow hover:shadow-md dark:border-amber-700'
          : 'h-full cursor-pointer transition-shadow hover:shadow-md'
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums">{primary}</div>
        <p className="text-muted-foreground mt-1 text-xs">{secondary}</p>
        {hint && <p className="text-muted-foreground mt-1 text-xs italic">{hint}</p>}
      </CardContent>
    </Card>
  );

  const clickable = onClick ? (
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
  ) : (
    <Link href={href} aria-label={title} className={`${wrapperClassName} block`}>
      {cardBody}
    </Link>
  );

  return (
    <div className="relative h-full">
      {clickable}
      {/*
       * FieldHelp floats over the card top-right corner. It's a
       * sibling of the clickable wrapper (NOT a child) because the
       * trigger is itself a button — nesting it would emit invalid
       * HTML and confuse assistive tech. Click events on the (i) do
       * not bubble through the card's button because they originate
       * outside it.
       */}
      <div className="absolute top-2 right-2 z-10">
        <FieldHelp title={title} contentClassName="w-80">
          {info}
        </FieldHelp>
      </div>
    </div>
  );
}

function ProviderCard({
  providers,
}: {
  providers: { provider: string; inFlight: number }[];
}): ReactElement {
  return (
    <div className="relative h-full">
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
                  <Badge
                    variant={p.inFlight > 10 ? 'destructive' : 'secondary'}
                    className="text-xs"
                  >
                    {p.inFlight}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <div className="absolute top-2 right-2 z-10">
        <FieldHelp title="Provider in-flight" contentClassName="w-80">
          <p>
            Live LLM, embedding, and transcription calls per provider, counted in this worker&apos;s
            process memory. Examples: <code>openai</code>, <code>anthropic</code>,{' '}
            <code>google-vertex</code>.
          </p>
          <p className="mt-2">
            In a multi-process deployment this only shows the worker your admin tab connected to —
            there is no per-user attribution at the proxy boundary, so the count is &quot;how many
            calls is this worker handling right now&quot;.
          </p>
          <p className="mt-2">
            A sustained count above ~10 on one provider warns of saturation that may trip the
            provider&apos;s rate limit or the circuit breaker. If you see this, check the
            provider&apos;s rate limits in their dashboard and consider lowering concurrency on the
            workflows driving it.
          </p>
        </FieldHelp>
      </div>
    </div>
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
