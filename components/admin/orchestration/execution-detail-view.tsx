'use client';

/**
 * ExecutionDetailView (Phase 7 Session 7.2)
 *
 * Client component that renders a workflow execution's summary,
 * error banner, input/output cards, and step timeline. Reuses the
 * existing `ExecutionTraceEntryRow` for each trace entry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RotateCcw,
  StopCircle,
  ThumbsUp,
  XCircle,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  useExecutionLivePoll,
  type CurrentStepDetails,
  type ExecutionLivePayload,
} from '@/lib/hooks/use-execution-live-poll';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/utils/format-duration';
import { formatStatus } from '@/lib/utils/format-status';
import {
  ExecutionTraceEntryRow,
  type TraceCostEntry,
} from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';
import { ExecutionAggregates } from '@/components/admin/orchestration/execution-aggregates';
import { ExecutionTimelineStrip } from '@/components/admin/orchestration/execution-timeline-strip';
import { JsonPretty } from '@/components/admin/orchestration/json-pretty';
import {
  MarkdownContent,
  MarkdownOrRawView,
} from '@/components/admin/orchestration/markdown-or-raw-view';
import { isMarkdown } from '@/lib/utils/is-markdown';
import {
  ExecutionTraceFilters,
  applyTraceFilter,
  type TraceFilter,
} from '@/components/admin/orchestration/execution-trace-filters';
import { buildParallelBranchMap } from '@/lib/orchestration/trace/aggregate';
import { getApprovalPrompt } from '@/lib/orchestration/trace/approval-prompt';
import { buildInterpolationContextFromTrace } from '@/lib/orchestration/engine/interpolate-from-trace';
import { ExecutionStatusSynopsis } from '@/components/admin/orchestration/execution-status-synopsis';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionInfo {
  id: string;
  workflowId: string;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  budgetLimitUsd: number | null;
  currentStep: string | null;
  inputData: unknown;
  outputData: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Same shape as `TraceCostEntry`, but carries the `stepId` link from the API. */
export interface TraceCostEntryRow extends TraceCostEntry {
  stepId: string;
}

export interface ExecutionDetailViewProps {
  execution: ExecutionInfo;
  trace: ExecutionTraceEntry[];
  /**
   * Cost-log rows attributed to this execution, keyed by `stepId` via
   * `metadata.stepId`. Returned by `GET /executions/:id` from Phase 2.
   * The view groups by stepId and renders a per-call sub-table inside
   * each expanded trace row.
   */
  costEntries?: TraceCostEntryRow[];
  /**
   * Running-step metadata for the live indicator. Server-fetched from
   * the same endpoint as `trace` so the initial paint already shows the
   * in-flight step. The live-poll hook owns this state thereafter.
   */
  currentStepDetails?: CurrentStepDetails | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
  paused_for_approval: 'outline',
  pending: 'outline',
};

// ─── Collapsible JSON card ──────────────────────────────────────────────────

function CollapsibleJsonCard({ title, data }: { title: string; data: unknown }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (data === null || data === undefined) return null;

  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const showMarkdown = isMarkdown(data);

  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard may be unavailable in non-secure contexts; silently ignore.
      }
    })();
  };

  return (
    <Card>
      <CardHeader className={cn('px-6', open ? 'pt-6 pb-2' : 'py-3')}>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex flex-1 items-center gap-2 text-left"
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="text-muted-foreground h-4 w-4" />
            ) : (
              <ChevronRight className="text-muted-foreground h-4 w-4" />
            )}
            <CardTitle className="text-sm">{title}</CardTitle>
          </button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={handleCopy}
            aria-label={`Copy ${title}`}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent>
          {showMarkdown ? <MarkdownOrRawView content={text} /> : <JsonPretty data={data} />}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ExecutionDetailView({
  execution,
  trace,
  costEntries,
  currentStepDetails,
}: ExecutionDetailViewProps) {
  const router = useRouter();

  // Live-poll seed. Once the hook has polled once it owns trace + cost +
  // currentStepDetails; the initial values here just paint the first frame.
  const initialPayload: ExecutionLivePayload = useMemo(
    () => ({
      snapshot: {
        id: execution.id,
        status: execution.status,
        currentStep: execution.currentStep,
        errorMessage: execution.errorMessage,
        totalTokensUsed: execution.totalTokensUsed,
        totalCostUsd: execution.totalCostUsd,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        createdAt: execution.createdAt,
      },
      trace,
      costEntries: costEntries ?? [],
      currentStepDetails: currentStepDetails ?? null,
    }),
    // Seed only — never re-run mid-mount; the hook owns the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const live = useExecutionLivePoll(execution.id, initialPayload);
  const liveSnap = live.snapshot;
  const liveTrace = live.trace;
  const liveCostEntries = live.costEntries;
  const liveCurrentStep = live.currentStepDetails;

  // Tick clock — advances every second while polling so the synthesised
  // running entry's durationMs ticks up smoothly between server polls.
  const [tickClock, setTickClock] = useState(0);
  useEffect(() => {
    if (!live.isPolling) return;
    const id = setInterval(() => setTickClock((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [live.isPolling]);

  // Display trace = persisted entries + synthesised running entry (if any).
  // The running entry is appended at the end so the timeline reads
  // chronologically. Defensive filter drops any persisted entry with the
  // same stepId in case a tick races the engine writing both at once.
  // `tickClock` is included so durationMs recomputes every second between
  // server polls.
  const displayTrace: ExecutionTraceEntry[] = useMemo(() => {
    if (!liveCurrentStep) return liveTrace;
    const synth = {
      stepId: liveCurrentStep.stepId,
      stepType: liveCurrentStep.stepType,
      label: liveCurrentStep.label,
      // The `status` union on persisted entries doesn't include 'running' —
      // the trace-row component locally widens it. Cast here intentionally
      // so the view-only display type stays narrow at the prop boundary.
      status: 'running',
      output: undefined,
      tokensUsed: 0,
      costUsd: 0,
      startedAt: liveCurrentStep.startedAt,
      durationMs: Math.max(0, Date.now() - new Date(liveCurrentStep.startedAt).getTime()),
    } as unknown as ExecutionTraceEntry;
    const persisted = liveTrace.filter((e) => e.stepId !== liveCurrentStep.stepId);
    return [...persisted, synth];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTrace, liveCurrentStep, tickClock]);

  // Interpolation context for the per-row "Show resolved" toggle.
  // Re-derives the LLM input client-side from the trace; vars set by the
  // engine's retry path (e.g. `vars.__retryContext`) aren't persisted in
  // the trace so they render as empty here. See
  // `interpolate-from-trace.ts` for the caveats.
  const interpolationContext = useMemo(
    () => buildInterpolationContextFromTrace(displayTrace, execution.inputData),
    [displayTrace, execution.inputData]
  );

  // Group cost entries by stepId so each ExecutionTraceEntryRow can render
  // its own per-call breakdown. Memoised so the grouping doesn't re-run
  // on every render.
  const costEntriesByStep = useMemo(() => {
    const map = new Map<string, TraceCostEntry[]>();
    for (const entry of liveCostEntries) {
      const existing = map.get(entry.stepId);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(entry.stepId, [entry]);
      }
    }
    return map;
  }, [liveCostEntries]);

  // Parallel-step grouping. Builds two lookups: which entries are
  // themselves a `parallel` fork (numbered #1, #2, …) and which entries
  // are an immediate concurrent branch of one. Caveat: this only catches
  // immediate branch children — downstream steps in a multi-step branch
  // chain aren't tagged because we don't have the workflow graph here.
  const { parallelForkNumberByStepId, parallelBranchOfByStepId } = useMemo(() => {
    const branchMap = buildParallelBranchMap(displayTrace);
    const forkNumbers = new Map<string, number>();
    for (const entry of displayTrace) {
      if (entry.stepType === 'parallel' && !forkNumbers.has(entry.stepId)) {
        forkNumbers.set(entry.stepId, forkNumbers.size + 1);
      }
    }
    const branchOf = new Map<string, number>();
    for (const [branchId, parentId] of branchMap.entries()) {
      const num = forkNumbers.get(parentId);
      if (num !== undefined) branchOf.set(branchId, num);
    }
    return { parallelForkNumberByStepId: forkNumbers, parallelBranchOfByStepId: branchOf };
  }, [displayTrace]);

  // Filter chip state — local to this view; not persisted.
  const [filter, setFilter] = useState<TraceFilter>('all');
  const filteredTrace = useMemo(
    () => applyTraceFilter(displayTrace, filter),
    [displayTrace, filter]
  );
  // Mirror filteredTrace into a ref so handleSelectStep can read the
  // current filtered set without re-creating the callback on every render.
  // Without this, the callback's dep array would have to include
  // filteredTrace, defeating its memoisation.
  const filteredTraceRef = useRef(filteredTrace);
  useEffect(() => {
    filteredTraceRef.current = filteredTrace;
  }, [filteredTrace]);

  const duration = formatDuration(liveSnap.startedAt, liveSnap.completedAt);
  const budgetUsed =
    execution.budgetLimitUsd && execution.budgetLimitUsd > 0
      ? (liveSnap.totalCostUsd / execution.budgetLimitUsd) * 100
      : null;

  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  // Tracks which trace row was last clicked from the timeline strip so the
  // matching row below can be highlighted and scrolled into view.
  const [highlightedStepId, setHighlightedStepId] = useState<string | null>(null);
  // Single-open accordion across the trace list — only one entry's input/
  // output panel is expanded at a time.
  const [expandedStepKey, setExpandedStepKey] = useState<string | null>(null);

  const handleSelectStep = useCallback((stepId: string) => {
    // Only reset the filter when the target row is hidden by the current
    // filter — otherwise we'd silently drop a deliberate filter selection
    // every time the user clicked a bar that was already visible.
    const visible = filteredTraceRef.current.some((e) => e.stepId === stepId);
    if (!visible) setFilter('all');
    setHighlightedStepId(stepId);
    // Defer to next paint so the highlighted row class is applied before scrolling.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="trace-entry-${stepId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);

  const handleCancel = useCallback(async () => {
    setActionLoading(true);
    setActionResult(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionCancel(execution.id));
      setActionResult({ type: 'success', message: 'Execution cancelled.' });
      router.refresh();
    } catch (err) {
      setActionResult({
        type: 'error',
        message: err instanceof APIClientError ? err.message : 'Cancel failed',
      });
    } finally {
      setActionLoading(false);
    }
  }, [execution.id, router]);

  const handleApprove = useCallback(async () => {
    setActionLoading(true);
    setActionResult(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionApprove(execution.id), {
        body: {},
      });
      setActionResult({
        type: 'success',
        message: 'Approved — execution resumed. Return to workflows to monitor progress.',
      });
      router.refresh();
    } catch (err) {
      setActionResult({
        type: 'error',
        message: err instanceof APIClientError ? err.message : 'Approval failed',
      });
    } finally {
      setActionLoading(false);
    }
  }, [execution.id, router]);

  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectLoading, setRejectLoading] = useState(false);

  const handleReject = useCallback(async () => {
    setRejectLoading(true);
    setActionResult(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionReject(execution.id), {
        body: { reason: rejectReason },
      });
      setActionResult({
        type: 'success',
        message: 'Execution rejected and cancelled.',
      });
      setRejectDialogOpen(false);
      setRejectReason('');
      router.refresh();
    } catch (err) {
      setActionResult({
        type: 'error',
        message: err instanceof APIClientError ? err.message : 'Rejection failed',
      });
      setRejectDialogOpen(false);
    } finally {
      setRejectLoading(false);
    }
  }, [execution.id, rejectReason, router]);

  const handleRetryStep = useCallback(
    async (stepId: string) => {
      setActionLoading(true);
      setActionResult(null);
      try {
        await apiClient.post(API.ADMIN.ORCHESTRATION.executionRetryStep(execution.id), {
          body: { stepId },
        });
        setActionResult({
          type: 'success',
          message: 'Execution reset for retry. Return to workflows to re-run.',
        });
        router.refresh();
      } catch (err) {
        setActionResult({
          type: 'error',
          message: err instanceof APIClientError ? err.message : 'Retry failed',
        });
      } finally {
        setActionLoading(false);
      }
    },
    [execution.id, router]
  );

  const canCancel = liveSnap.status === 'running' || liveSnap.status === 'paused_for_approval';
  const canApprove = liveSnap.status === 'paused_for_approval';
  const canRetry = liveSnap.status === 'failed';
  const failedStepId = canRetry
    ? displayTrace.find((e) => e.status === 'failed')?.stepId
    : undefined;

  // Extract approval prompt from awaiting trace entry
  const approvalPrompt = canApprove ? getApprovalPrompt(displayTrace) : null;

  return (
    <div className="space-y-6">
      {/* Action result banner */}
      {actionResult && (
        <div
          role="alert"
          className={cn(
            'flex items-center gap-2 rounded-md border px-4 py-3 text-sm',
            actionResult.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
          )}
        >
          {actionResult.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {actionResult.message}
        </div>
      )}

      {/* Action buttons */}
      {(canCancel || canApprove || (canRetry && failedStepId)) && (
        <div className="flex flex-wrap gap-2">
          {canApprove && (
            <Button size="sm" onClick={() => void handleApprove()} disabled={actionLoading}>
              <ThumbsUp className="mr-2 h-4 w-4" />
              Approve &amp; Continue
            </Button>
          )}
          {canApprove && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setRejectDialogOpen(true)}
              disabled={actionLoading}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Reject
            </Button>
          )}
          {canCancel && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCancel()}
              disabled={actionLoading}
            >
              <StopCircle className="mr-2 h-4 w-4" />
              Cancel Execution
            </Button>
          )}
          {canRetry && failedStepId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRetryStep(failedStepId)}
              disabled={actionLoading}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry Failed Step
            </Button>
          )}
        </div>
      )}

      {/* Approval prompt card — rendered as markdown because workflow
          authors compose these with headings, lists, fenced code etc. */}
      {approvalPrompt && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Approval prompt</p>
          <MarkdownContent
            content={approvalPrompt}
            className="mt-1 text-sm text-amber-900 dark:text-amber-100"
          />
        </div>
      )}

      {/* Summary section */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Status{' '}
              <FieldHelp title="Execution statuses">
                <strong>Pending</strong> — queued, not yet started. <strong>Running</strong> —
                engine is processing steps. <strong>Completed</strong> — all steps finished
                successfully. <strong>Failed</strong> — a step threw an error.{' '}
                <strong>Paused for approval</strong> — waiting for a human to review and approve
                before the workflow continues. <strong>Cancelled</strong> — stopped by a user before
                completion.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_BADGE[liveSnap.status] ?? 'outline'}>
                {formatStatus(liveSnap.status)}
              </Badge>
              {live.isPolling && (
                <span
                  data-testid="execution-live-pill"
                  className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-950/60 dark:text-green-300"
                  title="Polling for live updates"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                  Live
                </span>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Total Tokens{' '}
              <FieldHelp title="What are tokens?">
                Tokens are the units LLMs use to measure text — roughly ¾ of a word. Each workflow
                step consumes tokens; the total here is the sum across all steps.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-bold">{liveSnap.totalTokensUsed.toLocaleString()}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Total Cost{' '}
              <FieldHelp title="How cost is calculated">
                Each LLM step reports its token cost based on the provider&apos;s pricing. The total
                here is the sum across all steps. Non-LLM steps (guards, external calls) report $0.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-bold">${liveSnap.totalCostUsd.toFixed(4)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Budget{' '}
              <FieldHelp title="Budget usage">
                The dollar cap for this execution. The bar shows how much has been spent: green ≤
                70%, amber 70–90%, red &gt; 90%.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {execution.budgetLimitUsd !== null ? (
              <div>
                <span className="text-lg font-bold">${execution.budgetLimitUsd.toFixed(2)}</span>
                {budgetUsed !== null && (
                  <div className="mt-1">
                    <div className="bg-muted h-1.5 w-full rounded-full">
                      <div
                        className={cn(
                          'h-1.5 rounded-full',
                          budgetUsed > 90
                            ? 'bg-red-500'
                            : budgetUsed > 70
                              ? 'bg-amber-500'
                              : 'bg-green-500'
                        )}
                        style={{ width: `${Math.min(budgetUsed, 100)}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {budgetUsed.toFixed(1)}% used
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground text-lg">—</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Duration{' '}
              <FieldHelp title="Execution duration">
                Wall-clock time from when the engine started processing to completion. For running
                executions this updates on each page load. Includes wait time for approval steps.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-bold">{duration ?? '—'}</span>
          </CardContent>
        </Card>
      </div>

      {/* Status synopsis — the "what went wrong" panel. Renders the
          headline step, validator/executor reason, retry timeline,
          predecessor output snippet, and skip tally for any non-clean
          outcome. Subsumes the previous bare error banner: this
          component reads errorMessage too, plus richer context. */}
      <ExecutionStatusSynopsis
        execution={{
          status: liveSnap.status,
          errorMessage: liveSnap.errorMessage,
          currentStep: liveSnap.currentStep,
        }}
        trace={displayTrace}
        onJumpToStep={handleSelectStep}
        onRetry={canRetry ? (sid) => void handleRetryStep(sid) : undefined}
      />

      {/* Input / Output cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CollapsibleJsonCard title="Input Data" data={execution.inputData} />
        <CollapsibleJsonCard title="Output Data" data={execution.outputData} />
      </div>

      {/* Aggregates + timeline strip — both hidden when trace.length < 2. */}
      <ExecutionAggregates trace={displayTrace} />
      <ExecutionTimelineStrip
        trace={displayTrace}
        onSelectStep={handleSelectStep}
        highlightedStepId={highlightedStepId ?? undefined}
      />

      {/* Step timeline */}
      <section aria-label="Execution trace" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Step Timeline</h2>
          <ExecutionTraceFilters trace={displayTrace} active={filter} onChange={setFilter} />
        </div>
        {displayTrace.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">No trace entries recorded.</p>
        ) : filteredTrace.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm" data-testid="trace-empty-filter">
            No steps match the current filter.
          </p>
        ) : (
          <div className="space-y-2">
            {filteredTrace.map((entry, idx) => {
              const rowKey = `${entry.stepId}-${idx}`;
              // Engine semantics for `{{previous.output}}`: the most
              // recent completed step in the full trace, NOT the
              // previous DAG predecessor. Look back through
              // `displayTrace` (unfiltered) so the resolved view shows
              // what the engine actually saw even when the user has
              // filtered the visible rows.
              const fullIdx = displayTrace.findIndex((e) => e.stepId === entry.stepId);
              const previousStepId = fullIdx > 0 ? displayTrace[fullIdx - 1].stepId : undefined;
              return (
                <ExecutionTraceEntryRow
                  key={rowKey}
                  stepId={entry.stepId}
                  stepType={entry.stepType}
                  label={entry.label}
                  status={entry.status}
                  output={entry.output}
                  error={entry.error}
                  expectedSkip={entry.expectedSkip}
                  tokensUsed={entry.tokensUsed}
                  costUsd={entry.costUsd}
                  durationMs={entry.durationMs}
                  input={entry.input}
                  model={entry.model}
                  provider={entry.provider}
                  inputTokens={entry.inputTokens}
                  outputTokens={entry.outputTokens}
                  llmDurationMs={entry.llmDurationMs}
                  costEntries={costEntriesByStep.get(entry.stepId)}
                  provenance={entry.provenance}
                  retries={entry.retries}
                  highlighted={highlightedStepId === entry.stepId}
                  forkNumber={parallelForkNumberByStepId.get(entry.stepId)}
                  parallelBranchOfNumber={parallelBranchOfByStepId.get(entry.stepId)}
                  expanded={expandedStepKey === rowKey}
                  onExpandedChange={(next) => setExpandedStepKey(next ? rowKey : null)}
                  interpolationContext={interpolationContext}
                  previousStepId={previousStepId}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Reject Dialog ───────────────────────────────────────────────── */}
      <AlertDialog
        open={rejectDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRejectDialogOpen(false);
            setRejectReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject execution?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow will be cancelled and cannot be resumed. A reason is required for the
              audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason-detail">
              Reason <span className="text-destructive">*</span>{' '}
              <FieldHelp title="Rejection reason">
                A clear explanation of why this execution is being rejected. This is stored in the
                execution&apos;s error message (prefixed with &quot;Rejected:&quot;) and recorded in
                the audit trail. The workflow will be permanently cancelled and cannot be resumed.
              </FieldHelp>
            </Label>
            <Textarea
              id="reject-reason-detail"
              placeholder="Does not meet compliance requirements..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rejectLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleReject();
              }}
              disabled={rejectLoading || !rejectReason.trim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {rejectLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="mr-2 h-4 w-4" />
              )}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
