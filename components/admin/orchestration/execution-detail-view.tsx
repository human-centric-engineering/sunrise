'use client';

/**
 * ExecutionDetailView (Phase 7 Session 7.2)
 *
 * Client component that renders a workflow execution's summary,
 * error banner, input/output cards, and step timeline. Reuses the
 * existing `ExecutionTraceEntryRow` for each trace entry.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Loader2,
  Repeat,
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
  type RunningStep,
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
import { SaveToDatasetButton } from '@/components/admin/orchestration/evaluations-foundations/save-to-dataset-button';
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
import { buildDisplayTrace, buildParallelBranchMap } from '@/lib/orchestration/trace/aggregate';
import { getApprovalPrompt } from '@/lib/orchestration/trace/approval-prompt';
import { buildInterpolationContextFromTrace } from '@/lib/orchestration/engine/interpolate-from-trace';
import { ExecutionStatusSynopsis } from '@/components/admin/orchestration/execution-status-synopsis';
import { RerunExecutionDialog } from '@/components/admin/orchestration/rerun-execution-dialog';
import type { ExecutionTraceEntry } from '@/types/orchestration';
import { supervisorReportSchema } from '@/lib/validations/orchestration';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionInfo {
  id: string;
  workflowId: string;
  /**
   * Pinned `AiWorkflowVersion.id`. Null on legacy executions from
   * before the immutable-version model. The re-run dialog uses this
   * as the anchor for "show versions added since the original run".
   */
  versionId?: string | null;
  /**
   * When set, this execution was created by the rerun endpoint and
   * this points at the execution it was rerun from. The detail view
   * surfaces it as a "Re-run of execution X" breadcrumb. Null for
   * normal (non-rerun) executions.
   */
  parentExecutionId?: string | null;
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
  /**
   * Supervisor verdict from the `supervisor` step (in-workflow) or the
   * retroactive `/executions/:id/review` endpoint. Null when no
   * supervisor has run on this execution yet.
   */
  supervisorVerdict?: string | null;
  supervisorScore?: number | null;
  supervisorReport?: unknown;
  supervisorReviewedAt?: string | null;
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
   * In-flight step metadata for the live indicator. One entry per
   * running step — during a `parallel` step's fan-out this carries one
   * entry per branch. Server-fetched from the same endpoint as `trace`
   * so the initial paint already shows the in-flight steps. The
   * live-poll hook owns this state thereafter.
   */
  initialRunningSteps?: RunningStep[];
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

// ─── Supervisor verdict badge ───────────────────────────────────────────────

const VERDICT_BADGE: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pass: 'secondary',
  concerns: 'outline',
  fail: 'destructive',
  inconclusive: 'outline',
};

const VERDICT_LABEL: Record<string, string> = {
  pass: 'Pass',
  concerns: 'Concerns',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
};

function SupervisorVerdictBadge({
  verdict,
  score,
}: {
  verdict: string | null;
  score: number | null;
}): React.ReactElement {
  if (!verdict) {
    return <span className="text-muted-foreground text-lg">—</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={VERDICT_BADGE[verdict] ?? 'outline'}>
        {VERDICT_LABEL[verdict] ?? verdict}
      </Badge>
      {typeof score === 'number' && (
        <span
          className="text-muted-foreground text-xs"
          title="0.00 (worst) to 1.00 (best). Pass ≥ 0.80, Concerns 0.50–0.80, Fail < 0.50. Investigate anything below 0.50."
        >
          score {score.toFixed(2)} / 1.00
        </span>
      )}
    </div>
  );
}

// ─── Supervisor details panel ───────────────────────────────────────────────

interface SupervisorReportLike {
  verdict?: string;
  score?: number;
  summary?: string;
  weaknesses?: Array<{
    severity?: string;
    claim?: string;
    evidenceStepId?: string | null;
    recommendation?: string;
  }>;
  anomalies?: Array<{ stepId?: string; observation?: string }>;
  unverifiedAreas?: string[];
  invalidCitations?: Array<unknown>;
  parseFailure?: { rawResponse?: string; reason?: string };
  triggeredBy?: string;
  previousVerdicts?: Array<{ verdict?: string; reviewedAt?: string; triggeredBy?: string }>;
}

function asSupervisorReport(data: unknown): SupervisorReportLike | null {
  if (data === null || typeof data === 'undefined') return null;
  const parsed = supervisorReportSchema.safeParse(data);
  // The Zod-inferred type is a stricter superset of `SupervisorReportLike`
  // (which has every field optional for legacy UI defensiveness) — every
  // required field of the loose type is guaranteed present, so the
  // assignment is structurally safe and no cast is needed.
  return parsed.success ? parsed.data : null;
}

function SupervisorDetailsPanel({
  verdict,
  score,
  report,
  reviewedAt,
  onJumpToStep,
  reachableStepIds,
}: {
  verdict: string;
  score: number | null;
  report: unknown;
  reviewedAt: string | null;
  onJumpToStep: (stepId: string) => void;
  /** stepIds present in the visible trace — used to skip rendering a
   *  click-to-jump affordance for citations the operator can't navigate to.
   *  Cited steps not in this set still render as plain text so the citation
   *  isn't lost; they just don't get an interactive button. */
  reachableStepIds: ReadonlySet<string>;
}): React.ReactElement | null {
  const r = asSupervisorReport(report);
  if (!r) return null;
  const severityClass = {
    high: 'text-red-700 dark:text-red-300',
    medium: 'text-amber-700 dark:text-amber-300',
    low: 'text-muted-foreground',
  };
  const verdictColour = {
    pass: 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40',
    concerns: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40',
    fail: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40',
    inconclusive: 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40',
  };
  const bg = verdictColour[verdict as keyof typeof verdictColour] ?? verdictColour.inconclusive;
  return (
    <div
      className={cn('rounded-md border px-4 py-3 text-sm', bg)}
      data-testid="supervisor-details-panel"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="flex items-baseline gap-1 text-base font-semibold">
          Neutral supervisor review{' '}
          <FieldHelp title="What this panel shows" contentClassName="w-96 max-h-96 overflow-y-auto">
            <p>
              An independent judge model (configured via <code>EVALUATION_JUDGE_MODEL</code>)
              audited this execution after it finished and produced this evidence-cited report. The
              verdict comes in four shapes:
            </p>
            <p className="mt-2">
              <strong>Pass</strong>: every assertion the workflow made is grounded in the trace.{' '}
              <strong>Concerns</strong>: at least one weakness needs review. <strong>Fail</strong>:
              a critical issue — investigate before relying on the output.{' '}
              <strong>Inconclusive</strong>: the supervisor ran but its output couldn&apos;t be
              parsed.
            </p>
            <p className="mt-2">
              The <strong>score</strong> runs from 0.00 to 1.00. Higher is better. Pass usually
              scores 0.80 or higher, Concerns falls in 0.50–0.80, and Fail is below 0.50.{' '}
              <strong>Investigate any score below 0.50</strong>, and look closely at anything below
              0.70 even if the verdict says Pass — the supervisor flagged something.
            </p>
            <p className="mt-2">
              <strong>Weaknesses</strong> cite specific steps with verbatim quotes; the post-hoc
              citation validator strips any quote that doesn&apos;t actually appear in the cited
              step&apos;s output, and downgrades the verdict if the floor breaks.{' '}
              <strong>Anomalies</strong> flag stepIds with unusual patterns.{' '}
              <strong>Unverified areas</strong> are things the supervisor explicitly could not
              assess — a feature, not a bug.
            </p>
          </FieldHelp>
        </h3>
        <Badge variant={VERDICT_BADGE[verdict] ?? 'outline'}>
          {VERDICT_LABEL[verdict] ?? verdict}
        </Badge>
        {typeof score === 'number' && (
          <span
            className="text-muted-foreground text-xs"
            title="0.00 (worst) to 1.00 (best). Pass ≥ 0.80, Concerns 0.50–0.80, Fail < 0.50. Investigate anything below 0.50."
          >
            score {score.toFixed(2)} / 1.00
          </span>
        )}
        {reviewedAt && (
          <span className="text-muted-foreground ml-auto text-xs">
            reviewed {new Date(reviewedAt).toLocaleString()}
            {r.triggeredBy === 'retroactive' ? ' (retroactive)' : ''}
          </span>
        )}
      </div>

      {r.summary && <p className="mb-3">{r.summary}</p>}

      {r.weaknesses && r.weaknesses.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium tracking-wide uppercase">Weaknesses</p>
          <ul className="space-y-1">
            {r.weaknesses.map((w, i) => (
              <li key={i} className="text-sm">
                <span
                  className={cn(
                    'font-medium',
                    severityClass[w.severity as keyof typeof severityClass]
                  )}
                >
                  [{w.severity?.toUpperCase() ?? 'LOW'}]
                </span>{' '}
                {w.claim}
                {w.evidenceStepId && reachableStepIds.has(w.evidenceStepId) && (
                  <button
                    type="button"
                    onClick={() => onJumpToStep(w.evidenceStepId as string)}
                    className="ml-1 underline hover:no-underline"
                  >
                    (see step <code>{w.evidenceStepId}</code>)
                  </button>
                )}
                {w.evidenceStepId && !reachableStepIds.has(w.evidenceStepId) && (
                  <span
                    className="text-muted-foreground ml-1 text-xs"
                    title="The cited step isn't in the current trace — the supervisor may have referenced a step that was renamed, filtered out, or never persisted."
                  >
                    (cited step: <code>{w.evidenceStepId}</code>)
                  </span>
                )}
                {w.recommendation && (
                  <span className="text-muted-foreground"> — {w.recommendation}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.anomalies && r.anomalies.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium tracking-wide uppercase">Anomalies</p>
          <ul className="space-y-1">
            {r.anomalies.map((a, i) => (
              <li key={i} className="text-sm">
                {a.stepId && reachableStepIds.has(a.stepId) && (
                  <button
                    type="button"
                    onClick={() => onJumpToStep(a.stepId as string)}
                    className="font-mono text-xs underline hover:no-underline"
                  >
                    {a.stepId}
                  </button>
                )}
                {a.stepId && !reachableStepIds.has(a.stepId) && (
                  <span
                    className="text-muted-foreground font-mono text-xs"
                    title="The cited step isn't in the current trace."
                  >
                    {a.stepId}
                  </span>
                )}
                {a.stepId && ': '}
                {a.observation}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.unverifiedAreas && r.unverifiedAreas.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-medium tracking-wide uppercase">
            Areas the supervisor could not verify
          </p>
          <ul className="list-inside list-disc text-sm">
            {r.unverifiedAreas.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {r.invalidCitations && r.invalidCitations.length > 0 && (
        <p className="text-muted-foreground text-xs italic">
          The post-hoc citation validator stripped {r.invalidCitations.length} unsupported claim
          {r.invalidCitations.length === 1 ? '' : 's'}; the verdict may have been downgraded.
        </p>
      )}

      {r.parseFailure && (
        <details className="mt-2 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900 dark:bg-red-950/30">
          <summary className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-300">
            Supervisor output couldn&apos;t be parsed — show raw response
          </summary>
          {r.parseFailure.reason && (
            <p className="text-muted-foreground mt-2 text-xs">{r.parseFailure.reason}</p>
          )}
          <pre className="bg-background/60 mt-2 max-h-72 overflow-auto rounded border border-red-200 p-2 font-mono text-[11px] whitespace-pre-wrap dark:border-red-900">
            {r.parseFailure.rawResponse ?? '(no raw response captured)'}
          </pre>
          <p className="text-muted-foreground mt-2 text-xs">
            Tip: this is what the judge model returned after two attempts. Common failure modes are
            prose around the JSON (&quot;Here&apos;s my assessment:&quot;), markdown headers instead
            of a JSON object, or a top-level array. The parser is forgiving (strips fences and
            extracts the first balanced <code>{'{ … }'}</code> from prose); seeing this section
            means even those fallbacks failed.
          </p>
        </details>
      )}

      {r.previousVerdicts && r.previousVerdicts.length > 0 && (
        <p className="text-muted-foreground mt-2 text-xs">
          Prior verdicts archived: {r.previousVerdicts.map((p) => p.verdict).join(', ')}.
        </p>
      )}
    </div>
  );
}

// ─── Collapsible JSON card ──────────────────────────────────────────────────

function CollapsibleJsonCard({
  title,
  data,
  help,
  helpTitle,
}: {
  title: string;
  data: unknown;
  /** Optional FieldHelp body — when provided, an ⓘ icon is shown next to the title. */
  help?: React.ReactNode;
  /** Heading shown inside the help popover. Defaults to `title`. */
  helpTitle?: string;
}) {
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
          {help && <FieldHelp title={helpTitle ?? title}>{help}</FieldHelp>}
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
  initialRunningSteps,
}: ExecutionDetailViewProps) {
  const router = useRouter();

  // Live-poll seed. Once the hook has polled once it owns trace + cost +
  // currentRunningSteps; the initial values here just paint the first frame.
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
      currentRunningSteps: initialRunningSteps ?? [],
    }),
    // Seed only — never re-run mid-mount; the hook owns the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const live = useExecutionLivePoll(execution.id, initialPayload);
  const liveSnap = live.snapshot;
  const liveTrace = live.trace;
  const liveCostEntries = live.costEntries;
  const liveRunningSteps = live.currentRunningSteps;

  // Live clock — refreshes every second while polling so each synthesised
  // running entry's durationMs ticks up smoothly between server polls. We
  // store the timestamp itself (not a counter) so the memoised computations
  // below can read "now" from a dependency rather than calling Date.now()
  // during render (which React Compiler forbids).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live.isPolling) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live.isPolling]);

  // Display trace = persisted entries + one synthesised running entry per
  // in-flight step. During a parallel fan-out this surfaces every branch
  // simultaneously instead of just whichever started last. Defensive
  // filter drops any persisted entry with a stepId we're about to render
  // as running, in case a tick races the engine writing both. `nowMs`
  // is included so durationMs recomputes every second between server polls.
  //
  // When a parallel branch's running-step row carries `completedAt`, the
  // branch has finished but its sibling batch hasn't settled yet. Synth
  // it as `status: 'completed'` with the real completedAt — the timeline
  // strip uses it to render the coloured processing portion plus a
  // greyed wait portion that grows until the slowest sibling ends.
  const displayTrace: ExecutionTraceEntry[] = useMemo(() => {
    return buildDisplayTrace(liveTrace, liveRunningSteps, nowMs);
  }, [liveTrace, liveRunningSteps, nowMs]);

  // Per-step turnCount lookup for the synthesized running rows. Lives
  // outside the trace entry shape because ExecutionTraceEntry is also
  // used for persisted entries (where turnCount has no meaning), so
  // threading it as a side-channel keeps the trace type clean.
  const turnCountByStepId = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of liveRunningSteps) map.set(r.stepId, r.turnCount);
    return map;
  }, [liveRunningSteps]);

  // 1-indexed step number per trace entry, computed off the full
  // `displayTrace` (not `filteredTrace`) so the number reflects
  // canonical execution position and stays stable when the user filters
  // rows out. Keyed on entry-object identity rather than stepId so that
  // retries — which produce multiple entries with the same stepId — each
  // get their own number rather than colliding on a Map<stepId, number>.
  const stepNumberByEntry = useMemo(() => {
    const map = new Map<ExecutionTraceEntry, number>();
    displayTrace.forEach((entry, idx) => map.set(entry, idx + 1));
    return map;
  }, [displayTrace]);

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

  // Per-branch "wait time" — how long a parallel branch sat after it
  // finished before the slowest sibling did. Surfaced as the small
  // "+Xs waited for slower siblings" line under the duration in each
  // branch's trace row. The map is keyed by stepId; absence (or zero)
  // means no wait segment is shown for that row.
  //
  // While any sibling is still running, the wait is computed against
  // the live `nowMs` clock, so depending on it keeps the displayed value
  // ticking up smoothly between server polls.
  const parallelWaitMsByStepId = useMemo(() => {
    const map = new Map<string, number>();
    const branchMap = buildParallelBranchMap(displayTrace);
    if (branchMap.size === 0) return map;

    // Pass 1: latest sibling end per fork + any-running flag.
    const joinByFork = new Map<string, number>();
    const stillRunningByFork = new Map<string, boolean>();
    const endOf = (entry: ExecutionTraceEntry): number => {
      if (entry.completedAt) {
        const t = new Date(entry.completedAt).getTime();
        if (Number.isFinite(t)) return t;
      }
      if (entry.startedAt) {
        const s = new Date(entry.startedAt).getTime();
        if (Number.isFinite(s)) return s + Math.max(0, entry.durationMs);
      }
      return NaN;
    };

    for (const entry of displayTrace) {
      const parentFork = branchMap.get(entry.stepId);
      if (!parentFork) continue;
      if ((entry.status as string) === 'running') {
        stillRunningByFork.set(parentFork, true);
        continue;
      }
      const endMs = endOf(entry);
      if (!Number.isFinite(endMs)) continue;
      const cur = joinByFork.get(parentFork);
      if (cur === undefined || endMs > cur) joinByFork.set(parentFork, endMs);
    }

    for (const [forkId, joinEnd] of joinByFork.entries()) {
      if (stillRunningByFork.get(forkId)) {
        joinByFork.set(forkId, Math.max(joinEnd, nowMs));
      }
    }

    // Pass 2: per-branch wait.
    for (const entry of displayTrace) {
      const parentFork = branchMap.get(entry.stepId);
      if (!parentFork) continue;
      if ((entry.status as string) === 'running') continue;
      const endMs = endOf(entry);
      const joinMs = joinByFork.get(parentFork);
      if (!Number.isFinite(endMs) || joinMs === undefined) continue;
      const waitMs = joinMs - endMs;
      if (waitMs > 0) map.set(entry.stepId, waitMs);
    }

    return map;
    // nowMs keeps the wait ticking for still-running forks.
  }, [displayTrace, nowMs]);

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
    message: ReactNode;
  } | null>(null);
  // Supervisor panel auto-scroll + ring highlight after a (re-)review lands.
  // Without these, the success banner is the only feedback and the verdict
  // change happens well below the fold — operators routinely miss it.
  const supervisorPanelRef = useRef<HTMLDivElement | null>(null);
  const [highlightSupervisor, setHighlightSupervisor] = useState(false);
  // Detect when a fresh review's data has propagated through router.refresh()
  // by watching supervisorReviewedAt. We seed the ref with the initial value
  // so first-paint with an existing review doesn't trigger a spurious scroll.
  const prevReviewedAtRef = useRef<string | null>(execution.supervisorReviewedAt ?? null);
  useEffect(() => {
    const current = execution.supervisorReviewedAt ?? null;
    if (current && current !== prevReviewedAtRef.current) {
      prevReviewedAtRef.current = current;
      requestAnimationFrame(() => {
        supervisorPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      setHighlightSupervisor(true);
    }
  }, [execution.supervisorReviewedAt]);
  useEffect(() => {
    if (!highlightSupervisor) return;
    const t = setTimeout(() => setHighlightSupervisor(false), 2500);
    return () => clearTimeout(t);
  }, [highlightSupervisor]);
  const scrollToSupervisor = useCallback(() => {
    supervisorPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
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

  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectLoading, setRejectLoading] = useState(false);
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);

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

  // Retroactive supervisor review. Available on any terminal execution
  // — refreshes the row on success so the verdict badge re-renders.
  // Gated by a confirmation dialog because the action is billable
  // (judge-model LLM call, typically $0.02–$0.10).
  const handleReview = useCallback(async () => {
    setReviewDialogOpen(false);
    setActionLoading(true);
    setActionResult(null);
    // Capture the prior verdict BEFORE router.refresh() — once the refresh
    // lands, execution.supervisorVerdict holds the new value and we can no
    // longer show a before/after diff in the success banner.
    const previousVerdict = execution.supervisorVerdict ?? null;
    const previousScore = execution.supervisorScore ?? null;
    try {
      const result = await apiClient.post<{ verdict: string; score: number }>(
        API.ADMIN.ORCHESTRATION.executionReview(execution.id),
        { body: {} }
      );
      const newLabel = VERDICT_LABEL[result.verdict] ?? result.verdict;
      const prevLabel = previousVerdict
        ? (VERDICT_LABEL[previousVerdict] ?? previousVerdict)
        : null;
      setActionResult({
        type: 'success',
        message: (
          <span
            className="flex flex-wrap items-baseline gap-x-1"
            data-testid="execution-review-success"
          >
            <strong>{previousVerdict ? 'Re-review complete.' : 'Review complete.'}</strong>
            <span>
              New verdict: <strong>{newLabel}</strong> (score {result.score.toFixed(2)} / 1.00).
            </span>
            {prevLabel && (
              <span className="opacity-75">
                Previous: {prevLabel}
                {typeof previousScore === 'number' ? ` (${previousScore.toFixed(2)} / 1.00)` : ''}.
              </span>
            )}
            <button
              type="button"
              onClick={scrollToSupervisor}
              className="underline hover:no-underline"
              data-testid="jump-to-supervisor-details"
            >
              Jump to details ↓
            </button>
          </span>
        ),
      });
      router.refresh();
    } catch (err) {
      setActionResult({
        type: 'error',
        message: err instanceof APIClientError ? err.message : 'Review failed',
      });
    } finally {
      setActionLoading(false);
    }
  }, [
    execution.id,
    execution.supervisorVerdict,
    execution.supervisorScore,
    router,
    scrollToSupervisor,
  ]);

  const canCancel = liveSnap.status === 'running' || liveSnap.status === 'paused_for_approval';
  const canApprove = liveSnap.status === 'paused_for_approval';
  const canRetry = liveSnap.status === 'failed';
  const failedStepId = canRetry
    ? displayTrace.find((e) => e.status === 'failed')?.stepId
    : undefined;
  // Retroactive review is available on any terminal execution — operators
  // who skipped the supervisor at trigger time or whose template
  // doesn't include the step can still get an honest verdict.
  const canReview =
    liveSnap.status === 'completed' ||
    liveSnap.status === 'failed' ||
    liveSnap.status === 'cancelled';

  // Re-run is available for any terminal execution. We disable it for
  // in-flight runs (running / paused_for_approval) — those still have
  // moves left, so "re-run now" is almost certainly the wrong action.
  const canRerun =
    liveSnap.status === 'completed' ||
    liveSnap.status === 'failed' ||
    liveSnap.status === 'cancelled' ||
    liveSnap.status === 'rejected';

  // Capture-to-dataset is only meaningful on completed runs — the
  // capture helper rejects non-completed executions with a typed
  // error, and there's no useful expectedOutput to snapshot until the
  // run has finished anyway.
  const canCaptureToDataset = liveSnap.status === 'completed';

  // Extract approval prompt from awaiting trace entry
  const approvalPrompt = canApprove ? getApprovalPrompt(displayTrace) : null;

  return (
    <div className="space-y-6">
      {/* Re-run lineage breadcrumb. Only renders when this execution
          was created via the rerun endpoint. Plain anchor (not Next
          Link) is fine because the target is admin-only and we want
          a full reload to refresh the live-poll hook against the new
          execution's status. */}
      {execution.parentExecutionId && (
        <p className="text-muted-foreground text-xs" data-testid="execution-parent-breadcrumb">
          Re-run of execution{' '}
          <a
            href={`/admin/orchestration/executions/${execution.parentExecutionId}`}
            className="hover:text-foreground underline underline-offset-2"
          >
            {execution.parentExecutionId.slice(0, 8)}…
          </a>
        </p>
      )}

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
      {(canCancel || canApprove || (canRetry && failedStepId) || canReview || canRerun) && (
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
          {canReview && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReviewDialogOpen(true)}
              disabled={actionLoading}
              data-testid="execution-review-button"
            >
              <Eye className="mr-2 h-4 w-4" />
              {execution.supervisorVerdict ? 'Re-review' : 'Review this execution'}
            </Button>
          )}
          {canReview && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                asChild
                data-testid="execution-download-report-button"
              >
                <a
                  href={API.ADMIN.ORCHESTRATION.executionReportMarkdown(execution.id)}
                  download={`execution-${execution.id}.md`}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download report
                </a>
              </Button>
              <FieldHelp title="Execution report">
                A deterministic Markdown render of this execution — header, supervisor verdict (if
                one has been produced), input data, per-step timeline with inputs/outputs/duration/
                cost, error details, and output. <strong>No LLM cost</strong>; the report is
                generated fresh from the trace every time you click. Works on any terminal execution
                regardless of whether the workflow includes a <code>report</code> step.
              </FieldHelp>
            </div>
          )}
          {canRerun && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRerunDialogOpen(true)}
              disabled={actionLoading}
              data-testid="execution-rerun-button"
            >
              <Repeat className="mr-2 h-4 w-4" />
              Re-run
            </Button>
          )}
          {canCaptureToDataset && (
            <SaveToDatasetButton
              source={{
                kind: 'workflow_execution',
                executionId: execution.id,
                selector: { kind: 'last_step' },
              }}
              label="Save as test case"
            />
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
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
        <Card data-testid="supervisor-verdict-card">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">
              Supervisor{' '}
              <FieldHelp title="Neutral supervisor verdict">
                An independent judge model audits this execution&apos;s trace and produces an
                honest, evidence-cited verdict — designed to catch problems the workflow&apos;s own
                optimistic narrative would miss. <strong>Pass</strong>: every assertion is grounded
                in the trace. <strong>Concerns</strong>: at least one weakness needs review.{' '}
                <strong>Fail</strong>: critical issue — investigate before relying on the output.{' '}
                <strong>Inconclusive</strong>: the supervisor ran but its output couldn&apos;t be
                parsed (raw response preserved in <code>supervisorReport.parseFailure</code>). Null
                means no supervisor has run on this execution yet.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SupervisorVerdictBadge
              verdict={execution.supervisorVerdict ?? null}
              score={execution.supervisorScore ?? null}
            />
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

      {/* Supervisor details panel — full-width below the compact
          verdict card. Renders the summary, top weaknesses, anomalies,
          and unverified areas when a verdict is present. Without this
          the operator would have to scroll to the supervisor step row
          and expand it to learn why the verdict landed.

          Wrapped in a ref'd div so handleReview's success path can
          scroll-into-view and pulse a ring after a (re-)review lands. */}
      {execution.supervisorReport != null && execution.supervisorVerdict != null && (
        <div
          ref={supervisorPanelRef}
          className={cn(
            'rounded-md transition-shadow duration-500',
            highlightSupervisor && 'ring-primary ring-2 ring-offset-2'
          )}
        >
          <SupervisorDetailsPanel
            verdict={execution.supervisorVerdict}
            score={execution.supervisorScore ?? null}
            report={execution.supervisorReport}
            reviewedAt={execution.supervisorReviewedAt ?? null}
            onJumpToStep={handleSelectStep}
            reachableStepIds={new Set(displayTrace.map((e) => e.stepId))}
          />
        </div>
      )}

      {/* Input / Output cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CollapsibleJsonCard
          title="Input Data"
          data={execution.inputData}
          help={
            <>
              <p>
                The payload supplied when this execution was started — the same object the engine
                received from the caller.
              </p>
              <p className="mt-2">
                Source depends on how the run was triggered: a chat message, webhook body, scheduled
                trigger payload, MCP/API call, or the values entered on the admin{' '}
                <strong>Run workflow</strong> form.
              </p>
              <p className="mt-2">
                Steps reference it via <code>{'{{trigger.input.<field>}}'}</code>; top-level keys
                also seed <code>vars</code>, so <code>{'{{vars.<field>}}'}</code> resolves the same
                value at the start of the run.
              </p>
            </>
          }
        />
        <CollapsibleJsonCard
          title="Output Data"
          data={execution.outputData}
          help={
            <>
              <p>
                The map of every completed step&apos;s output, keyed by step id. The engine writes
                this only when the workflow reaches <strong>Completed</strong>; failed, cancelled,
                and paused runs leave it empty (use the Step Timeline below for those).
              </p>
              <p className="mt-2">
                It is the same object returned to whatever invoked the workflow — for example the
                response body of a webhook trigger or the value resolved by an{' '}
                <code>orchestrator</code> step in a parent workflow.
              </p>
            </>
          }
        />
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
                  description={entry.description}
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
                  requestParams={entry.requestParams}
                  costEntries={costEntriesByStep.get(entry.stepId)}
                  provenance={entry.provenance}
                  agent={entry.agent}
                  retries={entry.retries}
                  turnCount={turnCountByStepId.get(entry.stepId)}
                  stepNumber={stepNumberByEntry.get(entry)}
                  highlighted={highlightedStepId === entry.stepId}
                  forkNumber={parallelForkNumberByStepId.get(entry.stepId)}
                  parallelBranchOfNumber={parallelBranchOfByStepId.get(entry.stepId)}
                  parallelWaitMs={parallelWaitMsByStepId.get(entry.stepId)}
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

      {/* ─── Review confirmation dialog ────────────────────────────────────
          Retroactive supervisor review is a billable judge-model LLM call.
          A confirmation gate prevents accidental clicks from racking up
          cost — every existing audit verdict is preserved in
          supervisorReport.previousVerdicts[]. */}
      <AlertDialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          // Only react to explicit close — matches the reject-dialog
          // pattern and avoids a stale-handler race if Radix re-fires.
          if (!open) setReviewDialogOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {execution.supervisorVerdict ? 'Re-review this execution?' : 'Review this execution?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {execution.supervisorVerdict ? (
                <>
                  A new independent judge model will read the full trace and emit a fresh
                  evidence-cited verdict. The current verdict (
                  <strong>{execution.supervisorVerdict}</strong>) will be archived into{' '}
                  <code>supervisorReport.previousVerdicts[]</code>; nothing is lost.
                </>
              ) : (
                <>
                  An independent judge model will read the full execution trace and emit an
                  evidence-cited verdict (pass / concerns / fail). The verdict and full report
                  persist on the execution row and surface on this page.
                </>
              )}
              <br />
              <br />
              <strong>Cost:</strong> ~$0.02–$0.10 (one judge-model LLM call, depending on trace size
              and the configured <code>EVALUATION_JUDGE_MODEL</code>).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleReview();
              }}
              disabled={actionLoading}
              data-testid="execution-review-confirm"
            >
              {actionLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              {execution.supervisorVerdict ? 'Re-review' : 'Review'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RerunExecutionDialog
        open={rerunDialogOpen}
        onOpenChange={setRerunDialogOpen}
        execution={{
          id: execution.id,
          workflowId: execution.workflowId,
          versionId: execution.versionId ?? null,
        }}
      />
    </div>
  );
}
