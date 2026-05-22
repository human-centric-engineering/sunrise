'use client';

/**
 * ExecutionTraceEntryRow — one row in the live execution panel's
 * timeline. Renders a step's status pill, label, duration, tokens/cost,
 * and a collapsible output payload.
 */

import { useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  GitBranch,
  Loader2,
  Maximize2,
  RotateCcw,
  WrapText,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getStepMetadata, type StepCategory } from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';
import { isMarkdown } from '@/lib/utils/is-markdown';
import { JsonPretty } from '@/components/admin/orchestration/json-pretty';
import { MarkdownOrRawView } from '@/components/admin/orchestration/markdown-or-raw-view';
import { SourcesField } from '@/components/admin/orchestration/approvals/sources-field';
import {
  hasTemplateTokens,
  resolveTemplatesIn,
} from '@/lib/orchestration/engine/interpolate-from-trace';
import type { InterpolationContext } from '@/lib/orchestration/engine/interpolate-prompt';
import type { ExecutionTraceEntry } from '@/types/orchestration';

const RETRY_PILL_CLASS =
  'rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200';

/**
 * Trim a retry reason for inline display in the amber pill.
 *
 * The `validate_rationale` LLM guard's prompt asks the judge to quote
 * the offending change object after the prose, so producers get a
 * precise retry signal. That JSON is noise in the row-level summary —
 * the full output (including the verbatim reason) is one accordion
 * expand away in the step's output pane. We keep the prose, attach a
 * one-line summary of the offending object's salient keys (e.g.
 * `tierRole: "worker" → "thinking"`), and drop everything else.
 *
 * The full untrimmed reason is preserved in the row's `title` so it
 * still surfaces on hover without forcing an expansion.
 */
export function summariseRetryReason(reason: string): string {
  const braceAt = reason.indexOf('{');
  if (braceAt === -1) return reason.trim();

  const jsonText = sliceBalancedBraces(reason, braceAt);
  const tail = jsonText ? summariseOffendingObject(jsonText) : null;

  // When we can produce a tail summary, strip the redundant
  // "Offending change:" lead-in from the prefix — the tail conveys
  // the same signal more concisely. When we can't, keep the marker
  // so the operator still knows something was attached.
  const rawPrefix = reason.slice(0, braceAt).replace(/```(?:json)?\s*$/i, '');
  const prefix = (
    tail
      ? rawPrefix.replace(/\b(Offending(?:\s+(?:change|object|item))?)\s*:?\s*$/i, '')
      : rawPrefix
  )
    .trim()
    .replace(/[\s.,;:—-]+$/, '');

  if (!prefix && !tail) return reason.trim();
  if (!tail) return `${prefix}.`;
  return prefix ? `${prefix} — ${tail}` : tail;
}

function sliceBalancedBraces(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function summariseOffendingObject(jsonText: string): string | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Field-change shape: `{ field, currentValue, proposedValue, ... }`.
  // This is the dominant offending-object shape across the audit
  // template's guards, so name the field and show the transition.
  if (typeof obj.field === 'string' && 'currentValue' in obj && 'proposedValue' in obj) {
    return `${obj.field}: ${formatValue(obj.currentValue)} → ${formatValue(obj.proposedValue)}`;
  }

  // Model-shape: `{ modelName, providerSlug, ... }`. Used when the
  // judge quotes the whole proposal rather than a single change.
  if (typeof obj.modelName === 'string' && typeof obj.providerSlug === 'string') {
    return `${obj.modelName} (${obj.providerSlug})`;
  }
  if (typeof obj.slug === 'string') return obj.slug;
  if (typeof obj.modelId === 'string') return String(obj.modelId);

  // Generic fallback: first couple of scalar keys, comma-joined.
  const scalars: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      scalars.push(`${k}=${formatValue(v)}`);
      if (scalars.length === 2) break;
    }
  }
  return scalars.length > 0 ? scalars.join(', ') : null;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => typeof x === 'string')) {
      return `[${v.map((x) => `"${x}"`).join(', ')}]`;
    }
    return `[…${v.length}]`;
  }
  if (typeof v === 'object') return '{…}';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  return '…';
}

type Status = ExecutionTraceEntry['status'] | 'running';

/**
 * Subset of an `AiCostLog` row attributed to a single step, used by the
 * trace viewer to render per-LLM-call detail under multi-turn executors
 * (`tool_call`, `agent_call`, `orchestrator`). Comes from the
 * `costEntries[]` payload returned by `GET /executions/:id`.
 */
export interface TraceCostEntry {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  operation: string;
  createdAt: string;
}

export interface ExecutionTraceEntryRowProps {
  stepId: string;
  stepType: string;
  label: string;
  /**
   * Optional `WorkflowStep.description` snapshot. When set, renders as
   * a muted paragraph at the top of the expanded accordion body
   * (above the input / output panes). Absent for steps authored
   * without a description. Not shown on the collapsed row at all —
   * the row stays compact and the description is revealed by
   * expanding the row.
   */
  description?: string;
  status: Status;
  output?: unknown;
  error?: string;
  /**
   * Set by the engine when a skipped step's config opted into
   * `expectedSkip`. Tells the row to render the skip in muted slate
   * styling instead of treating it as an unexpected failure.
   */
  expectedSkip?: boolean;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  /** New optional Phase-1 fields. Absent when the engine didn't capture them. */
  input?: unknown;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  llmDurationMs?: number;
  /**
   * Request envelope rolled up from the final LLM turn (`rollupTelemetry`).
   * Surfaced inline next to model/provider/tokens so a `400 Unsupported
   * parameter` 400 is self-diagnosing in the trace viewer. Absent for
   * non-LLM steps and historical rows from before this field existed.
   */
  requestParams?: ExecutionTraceEntry['requestParams'];
  /** Cost-log rows attributed to this step, for the per-call breakdown. */
  costEntries?: TraceCostEntry[];
  /**
   * Source attribution lifted by the engine from the step's `output.sources`.
   * Rendered as a Sources sub-panel under the Input/Output grid in the
   * expanded body — same pill design as the structured approval UI, so
   * admins debugging an execution see the audit trail without leaving
   * the trace viewer.
   */
  provenance?: ExecutionTraceEntry['provenance'];
  /**
   * View-time enrichment for `agent_call` steps. The API loader resolves
   * `config.agentSlug` against the AiAgent registry once per execution
   * load and attaches the `{ id, slug, name }` here. Rendered as an
   * "Agent · {name}" chip with a link to the agent's edit page on the
   * collapsed row, next to the step-type pill. Absent for non-agent_call
   * steps and for slugs that no longer resolve to an active agent.
   */
  agent?: ExecutionTraceEntry['agent'];
  /**
   * Bounded-retry events emitted from this step. Rendered as amber
   * sub-rows so users can see at a glance which step looped, how many
   * attempts ran, and why each one failed.
   */
  retries?: ExecutionTraceEntry['retries'];
  /**
   * Live progress indicator for multi-turn steps. The detail view sets
   * this on the synthesized "running" row from `currentRunningSteps[*].
   * turnCount`. Renders as a small "N turns" pill next to the duration
   * so long `agent_call` / `orchestrator` / `reflect` steps show
   * forward progress instead of looking frozen. Only honored when
   * `status === 'running'`; ignored on persisted/completed rows.
   */
  turnCount?: number;
  /**
   * 1-indexed position of this row in the trace as rendered. Shown as a
   * small `#N` prefix on the label so the operator can reference a
   * specific step by number ("scroll to step 7", "step 3 failed").
   * Sequential in render order — during a `parallel` fan-out each
   * branch gets its own number rather than sharing one.
   */
  stepNumber?: number;
  /** When true, render with a highlighted background (used by timeline-strip clicks). */
  highlighted?: boolean;
  /** Fires when the user clicks "Retry" on a failed step. */
  onRetry?: (stepId: string) => void;
  /**
   * Parallel fan-out grouping. When this row is the fork step itself,
   * `forkNumber` is set. When this row is an immediate branch of a fork,
   * `parallelBranchOfNumber` carries the fork's number so the row can show
   * a "branch of fork #N" chip and an indigo left-rail. Both are derived
   * via `buildParallelBranchMap` in the parent view. (Indigo is reserved
   * for this structural accent; the orchestrator step type owns purple.)
   */
  forkNumber?: number;
  parallelBranchOfNumber?: number;
  /**
   * Ms this branch sat waiting for the slowest sibling to finish — i.e.
   * the gap between this branch's own end and the fork's join time.
   * Set only on rows that are an immediate branch of a parallel fork
   * and that finished before at least one sibling. Rendered as a small
   * "+Xs waited for slower siblings" line under the duration so the
   * operator can see at a glance which branches ate idle time. The
   * parent view recomputes this each tick while siblings are still
   * running, so the displayed value grows live.
   */
  parallelWaitMs?: number;
  /**
   * Controlled expand state. When provided, the row is in controlled mode
   * and the parent owns which entry is open — used to enforce
   * single-open accordion behaviour across the trace list. When omitted,
   * the row manages its own toggle locally (legacy behaviour).
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Context used to re-derive what the LLM actually received at this
   * step. When provided AND `input` contains `{{...}}` template tokens,
   * the expanded body offers a "Resolved" toggle that swaps the raw
   * config view for an interpolated one. Built once at the trace-view
   * level so we don't rebuild it for every row. See
   * `interpolate-from-trace.ts`.
   */
  interpolationContext?: InterpolationContext;
  /**
   * Id of the step that ran immediately before this one (engine
   * semantics — most recent completed step). Used for the
   * `{{previous.output}}` token. Optional; if omitted, that token
   * resolves to empty.
   */
  previousStepId?: string;
}

const STATUS_STYLES: Record<Status, { icon: React.ElementType; colour: string; text: string }> = {
  running: { icon: Loader2, colour: 'text-blue-500', text: 'Running' },
  completed: { icon: CheckCircle2, colour: 'text-green-500', text: 'Completed' },
  failed: { icon: XCircle, colour: 'text-red-500', text: 'Failed' },
  skipped: { icon: ChevronRight, colour: 'text-muted-foreground', text: 'Skipped' },
  awaiting_approval: { icon: Clock, colour: 'text-amber-500', text: 'Awaiting approval' },
  rejected: { icon: XCircle, colour: 'text-red-500', text: 'Rejected' },
};

export function ExecutionTraceEntryRow({
  stepId,
  stepType,
  label,
  description,
  status,
  output,
  error,
  expectedSkip,
  tokensUsed = 0,
  costUsd = 0,
  durationMs,
  input,
  model,
  provider,
  inputTokens,
  outputTokens,
  llmDurationMs,
  requestParams,
  costEntries,
  provenance,
  agent,
  retries,
  turnCount,
  stepNumber,
  highlighted,
  onRetry,
  forkNumber,
  parallelBranchOfNumber,
  parallelWaitMs,
  expanded: expandedProp,
  onExpandedChange,
  interpolationContext,
  previousStepId,
}: ExecutionTraceEntryRowProps) {
  const [expandedInternal, setExpandedInternal] = useState(false);
  const [inputView, setInputView] = useState<'raw' | 'resolved'>('raw');
  const canResolveInput =
    interpolationContext !== undefined && input !== undefined && hasTemplateTokens(input);
  const resolvedInput =
    canResolveInput && inputView === 'resolved'
      ? resolveTemplatesIn(input, interpolationContext, previousStepId)
      : undefined;
  const isControlled = expandedProp !== undefined;
  const expanded = isControlled ? expandedProp : expandedInternal;
  const toggleExpanded = () => {
    const next = !expanded;
    if (isControlled) {
      onExpandedChange?.(next);
    } else {
      setExpandedInternal(next);
    }
  };
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  const animate = status === 'running' ? 'animate-spin' : '';

  // Latency breakdown — the `llmDurationMs` is a subset of total `durationMs`.
  // Show "engine + tool I/O" as the remainder, which is the most useful framing.
  const otherMs =
    typeof durationMs === 'number' && typeof llmDurationMs === 'number'
      ? Math.max(0, durationMs - llmDurationMs)
      : null;

  return (
    <div
      data-testid={`trace-entry-${stepId}`}
      data-parallel-fork={forkNumber !== undefined ? 'true' : undefined}
      data-parallel-branch-of={parallelBranchOfNumber}
      className={cn(
        'border-border/60 rounded-md border p-3 text-sm transition-colors',
        highlighted && 'bg-muted/40 ring-primary/40 ring-1',
        // Indigo, not purple — the orchestrator step type owns purple, so
        // structural fork/branch accents have to read distinctly.
        parallelBranchOfNumber !== undefined &&
          'border-l-4 border-l-indigo-400 dark:border-l-indigo-600'
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-start gap-2 text-left"
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.colour, animate)} />
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {typeof stepNumber === 'number' && (
              <span
                data-testid={`trace-entry-step-number-${stepId}`}
                className="text-muted-foreground font-mono text-xs tabular-nums"
                title={`Step ${stepNumber} in execution order`}
              >
                #{stepNumber}
              </span>
            )}
            <span className="font-medium">{label}</span>
            <StepTypeChip stepId={stepId} stepType={stepType} />
            {agent && (
              // Agent chip — only renders for `agent_call` steps that
              // resolved to a registered agent. Sits next to the step
              // type pill so the operator sees which agent ran the
              // step at a glance and can jump to its edit page.
              // `e.stopPropagation()` keeps the click from also
              // toggling the row's expand affordance.
              <a
                href={`/admin/orchestration/agents/${agent.id}`}
                onClick={(e) => e.stopPropagation()}
                data-testid={`trace-entry-agent-${stepId}`}
                title={`Agent slug: ${agent.slug}`}
                className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800 hover:bg-blue-200 dark:bg-blue-950/60 dark:text-blue-200 dark:hover:bg-blue-900/60"
              >
                Agent · {agent.name}
              </a>
            )}
            {forkNumber !== undefined && (
              <span
                data-testid={`trace-entry-fork-${stepId}`}
                className="flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                title="This step fans out concurrent branches"
              >
                <GitBranch className="h-3 w-3" />
                Parallel fork #{forkNumber}
              </span>
            )}
            {parallelBranchOfNumber !== undefined && (
              <span
                data-testid={`trace-entry-branch-${stepId}`}
                className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                title={`Concurrent branch of parallel fork #${parallelBranchOfNumber}`}
              >
                ∥ Branch of fork #{parallelBranchOfNumber}
              </span>
            )}
            {model && (
              <span
                data-testid={`trace-entry-model-${stepId}`}
                className="bg-muted/60 text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px]"
                title={provider ? `Provider: ${provider}` : undefined}
              >
                {provider ? `${provider} · ${model}` : model}
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span>{style.text}</span>
            {typeof durationMs === 'number' && <span>{durationMs.toLocaleString()} ms</span>}
            {typeof parallelWaitMs === 'number' && parallelWaitMs > 0 && (
              <span
                data-testid={`trace-entry-parallel-wait-${stepId}`}
                title="Time this branch sat waiting for slower sibling branches to finish"
                className="text-muted-foreground/80"
              >
                +{parallelWaitMs.toLocaleString()} ms waited for siblings
              </span>
            )}
            {status === 'running' && typeof turnCount === 'number' && turnCount > 0 && (
              <span data-testid={`trace-entry-turn-count-${stepId}`}>
                {turnCount === 1 ? '1 turn' : `${turnCount.toLocaleString()} turns`}
              </span>
            )}
            {typeof llmDurationMs === 'number' && llmDurationMs > 0 && otherMs !== null && (
              <span data-testid={`trace-entry-latency-breakdown-${stepId}`}>
                LLM {llmDurationMs.toLocaleString()} ms · other {otherMs.toLocaleString()} ms
              </span>
            )}
            {(typeof inputTokens === 'number' || typeof outputTokens === 'number') &&
            (inputTokens || outputTokens) ? (
              <span>
                {(inputTokens ?? 0).toLocaleString()} in · {(outputTokens ?? 0).toLocaleString()}{' '}
                out
              </span>
            ) : tokensUsed > 0 ? (
              <span>{tokensUsed.toLocaleString()} tokens</span>
            ) : null}
            {costUsd > 0 && <span>${costUsd.toFixed(4)}</span>}
          </div>
          {requestParams && (
            <p
              data-testid={`trace-entry-request-params-${stepId}`}
              className="text-muted-foreground/80 mt-0.5 font-mono text-[11px]"
              title="Request envelope sent to the LLM provider on the final turn of this step"
            >
              Request —{' '}
              {[
                typeof requestParams.maxTokens === 'number'
                  ? `maxTokens: ${requestParams.maxTokens.toLocaleString()}`
                  : null,
                typeof requestParams.temperature === 'number'
                  ? `temperature: ${requestParams.temperature}`
                  : null,
                requestParams.reasoningEffort
                  ? `reasoning: ${requestParams.reasoningEffort}`
                  : null,
                requestParams.responseFormat ? `response: ${requestParams.responseFormat}` : null,
                typeof requestParams.toolCount === 'number' && requestParams.toolCount > 0
                  ? `tools: ${requestParams.toolCount}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {/* Skipped steps surface their reason inline so the operator
              doesn't have to expand the row to see why the step was
              skipped. When the engine didn't capture an error (e.g.
              pre-fix executions or a future code path that forgets to
              wire skipError through), fall back to a neutral hint so
              the row still explains itself. */}
          {status === 'skipped' && (
            <p
              data-testid={`trace-entry-skip-reason-${stepId}`}
              data-expected-skip={expectedSkip ? 'true' : undefined}
              className={cn(
                'mt-0.5 line-clamp-2 text-xs italic',
                // Expected skips are part of the workflow's happy path —
                // render them quieter than a "something went wrong" skip
                // so the eye lands on real problems.
                expectedSkip ? 'text-muted-foreground/70' : 'text-muted-foreground'
              )}
              title={error ?? undefined}
            >
              {expectedSkip ? 'Optional step skipped' : 'Skipped'}:{' '}
              {error ? summariseError(error) : 'no reason captured'}
            </p>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-4 w-4" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4" />
        )}
      </button>

      {retries && retries.length > 0 && (
        <ul className="mt-2 ml-6 space-y-1" data-testid={`trace-entry-retries-${stepId}`}>
          {retries.map((r, i) => (
            <li key={i} className={cn('flex items-start gap-2', RETRY_PILL_CLASS)}>
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">
                  {r.exhausted
                    ? `Retry budget exhausted — routed to ${r.targetStepId}`
                    : `Attempt ${r.attempt} of ${r.maxRetries} failed — re-running ${r.targetStepId}`}
                </p>
                {r.reason && (
                  <p className="mt-0.5 break-words opacity-80" title={r.reason}>
                    Reason: {summariseRetryReason(r.reason)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 border-t pt-2">
          {description && (
            <p
              data-testid={`trace-entry-description-${stepId}`}
              className="text-muted-foreground text-xs leading-relaxed"
            >
              {description}
            </p>
          )}
          {error && <ErrorPane error={error} stepId={stepId} expected={expectedSkip} />}
          {(input !== undefined || output !== undefined) && (
            <div className="grid gap-2 lg:grid-cols-2">
              {input !== undefined && input !== null && (
                <JsonPane
                  label="Input"
                  data={
                    inputView === 'resolved' && resolvedInput !== undefined ? resolvedInput : input
                  }
                  testId={`trace-entry-input-${stepId}`}
                  toolbar={
                    canResolveInput ? (
                      <button
                        type="button"
                        onClick={() => setInputView((v) => (v === 'raw' ? 'resolved' : 'raw'))}
                        className="text-muted-foreground hover:text-foreground text-[10px] font-medium tracking-wide uppercase underline-offset-2 hover:underline"
                        title={
                          inputView === 'raw'
                            ? 'Substitute {{stepId.output}} and {{input.foo}} tokens against the recorded trace'
                            : 'Switch back to the raw config snapshot'
                        }
                        data-testid={`trace-entry-input-resolve-toggle-${stepId}`}
                      >
                        {inputView === 'raw' ? 'Show resolved' : 'Show raw'}
                      </button>
                    ) : undefined
                  }
                />
              )}
              {output !== undefined && output !== null && (
                <JsonPane label="Output" data={output} testId={`trace-entry-output-${stepId}`} />
              )}
            </div>
          )}
          {provenance && provenance.length > 0 && (
            <div data-testid={`trace-entry-sources-${stepId}`}>
              <p className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">
                Sources ({provenance.length})
              </p>
              <SourcesField value={provenance} layout="stack" />
            </div>
          )}
          {costEntries && costEntries.length > 0 && (
            <div data-testid={`trace-entry-cost-entries-${stepId}`}>
              <p className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">
                Per-call cost ({costEntries.length})
              </p>
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th className="py-1 pr-2 font-normal">Model</th>
                    <th className="py-1 pr-2 font-normal">In</th>
                    <th className="py-1 pr-2 font-normal">Out</th>
                    <th className="py-1 pr-2 font-normal">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {costEntries.map((entry, idx) => (
                    <tr
                      key={`${entry.createdAt}-${idx}`}
                      className="border-border/40 border-b last:border-b-0"
                    >
                      <td className="py-0.5 pr-2 font-mono">
                        {entry.provider}/{entry.model}
                      </td>
                      <td className="py-0.5 pr-2">{entry.inputTokens.toLocaleString()}</td>
                      <td className="py-0.5 pr-2">{entry.outputTokens.toLocaleString()}</td>
                      <td className="py-0.5 pr-2">${entry.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {status === 'failed' && onRetry && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(stepId);
              }}
            >
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              Retry from this step
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Tonal chip palette per step-type category. Pairs the workflow builder's
// `STEP_CATEGORY_COLOURS` iconBg/text combo so the chip in the trace row,
// the bar in the timeline strip, and the node in the workflow builder
// canvas all read as the same colour family. Unknown types fall back to
// the neutral muted palette so a renamed/removed step type doesn't go
// blank.
const STEP_TYPE_CHIP_CLASSES: Record<StepCategory, string> = {
  orchestration: 'bg-purple-100 text-purple-900 dark:bg-purple-900/60 dark:text-purple-100',
  agent: 'bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100',
  decision: 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100',
  output: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100',
  input: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
};

const STEP_TYPE_CHIP_FALLBACK = 'bg-muted text-muted-foreground';

function StepTypeChip({ stepId, stepType }: { stepId: string; stepType: string }) {
  const meta = getStepMetadata(stepType);
  const chipColour = meta ? STEP_TYPE_CHIP_CLASSES[meta.category] : STEP_TYPE_CHIP_FALLBACK;
  // Always render the chip; only attach a tooltip when we have a real
  // description from the registry. Unknown step types still render the
  // raw type string so admins aren't left with a missing chip.
  const chip = (
    <span
      data-testid={`trace-entry-step-type-${stepId}`}
      data-category={meta?.category ?? undefined}
      className={cn(
        'rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase',
        chipColour
      )}
    >
      {stepType}
    </span>
  );
  if (!meta) return chip;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-left">
          <p className="font-medium">{meta.label}</p>
          <p className="text-primary-foreground/80 mt-1 text-[11px] leading-snug">
            {meta.description}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function JsonPane({
  label,
  data,
  testId,
  toolbar,
}: {
  label: string;
  data: unknown;
  testId: string;
  /** Optional extra control rendered alongside the Copy button. */
  toolbar?: React.ReactNode;
}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const showMarkdown = isMarkdown(data);
  const [copied, setCopied] = useState(false);
  // Inline wrap is off by default — the original horizontal-scroll layout
  // is still useful for skimming JSON shape. The operator opts in when a
  // single value is too long to read sideways.
  const [wrap, setWrap] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);
  // Dialog has its own wrap state, defaulted ON because the whole point
  // of opening the bigger viewer is to read long values comfortably.
  // Independent of the inline state so closing the dialog leaves the
  // compact view untouched.
  const [dialogWrap, setDialogWrap] = useState(true);

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

  const copyButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 gap-1 px-1.5 text-[11px]"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copy
        </>
      )}
    </Button>
  );

  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {label}
        </p>
        <div className="flex items-center gap-2">
          {toolbar}
          {/* Wrap toggle is only meaningful for the JSON path. Markdown
              wraps naturally via prose styling, and the raw fallback in
              MarkdownOrRawView already breaks on whitespace. */}
          {!showMarkdown && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                setWrap((v) => !v);
              }}
              aria-pressed={wrap}
              aria-label={wrap ? `Stop wrapping ${label}` : `Wrap long ${label} lines`}
              data-testid={`${testId}-wrap-toggle`}
              title={
                wrap
                  ? 'Showing wrapped — click to revert to horizontal scroll'
                  : 'Wrap long lines while keeping JSON indentation'
              }
            >
              <WrapText className="h-3 w-3" />
              {wrap ? 'No wrap' : 'Wrap'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              setExpandOpen(true);
            }}
            aria-label={`Expand ${label}`}
            data-testid={`${testId}-expand`}
            title="Open in a larger viewer"
          >
            <Maximize2 className="h-3 w-3" />
            Expand
          </Button>
          {copyButton}
        </div>
      </div>
      {showMarkdown ? (
        <MarkdownOrRawView content={text} rawMaxHeightClass="max-h-60 overflow-y-auto" />
      ) : (
        <JsonPretty data={data} wrap={wrap} className="max-h-60 overflow-y-auto" />
      )}

      <Dialog open={expandOpen} onOpenChange={setExpandOpen}>
        <DialogContent
          className="max-h-[90vh] max-w-5xl gap-3"
          data-testid={`${testId}-dialog`}
          onClick={(e) => e.stopPropagation()}
          // The title (e.g. "Input" / "Output") plus the toolbar context
          // is enough — no separate description sentence to add.
          aria-describedby={undefined}
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-sm font-medium tracking-wide uppercase">
              {label}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Re-mount the same toolbar slot here so the input pane's
                "Show resolved" toggle is available without leaving the
                dialog. State is owned by the parent, so flipping it
                inside the dialog updates the inline view too — and
                vice versa. */}
            {toolbar}
            {!showMarkdown && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => setDialogWrap((v) => !v)}
                aria-pressed={dialogWrap}
                data-testid={`${testId}-dialog-wrap-toggle`}
              >
                <WrapText className="h-3 w-3" />
                {dialogWrap ? 'No wrap' : 'Wrap'}
              </Button>
            )}
            {copyButton}
          </div>
          {showMarkdown ? (
            <MarkdownOrRawView content={text} rawMaxHeightClass="max-h-[70vh] overflow-y-auto" />
          ) : (
            <JsonPretty data={data} wrap={dialogWrap} className="max-h-[70vh] overflow-y-auto" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Short, single-line summary of an error message for the collapsed
 * trace row. Step-step errors are often multi-line (sanitised stack
 * traces, JSON payloads, structured details) — the dropdown shows the
 * full thing, this just gives the operator enough to triage.
 */
const ERROR_SUMMARY_MAX = 120;
function summariseError(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? message;
  if (firstLine.length <= ERROR_SUMMARY_MAX) return firstLine;
  return `${firstLine.slice(0, ERROR_SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * Expanded-row error display. Wraps the existing red `<pre>` with a
 * Copy button so operators can grab the full message for an issue
 * tracker or chat without selecting the text manually.
 */
function ErrorPane({
  error,
  stepId,
  expected,
}: {
  error: string;
  stepId: string;
  expected?: boolean;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void (async () => {
      try {
        await navigator.clipboard.writeText(error);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard may be unavailable in non-secure contexts; silently ignore.
      }
    })();
  };

  // Two visual modes. "Error" (red) is the default; "Skip reason" (slate)
  // applies when the workflow author opted into expectedSkip — the text
  // still carries the diagnostic, but the colour is no longer alarmist.
  const heading = expected ? 'Skip reason' : 'Error';
  const headingClass = expected ? 'text-muted-foreground' : 'text-red-700 dark:text-red-300';
  const preClass = expected
    ? 'bg-muted/50 text-foreground/80'
    : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200';

  return (
    <div
      data-testid={`trace-entry-error-${stepId}`}
      data-expected-skip={expected ? 'true' : undefined}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className={cn('text-[11px] font-medium tracking-wide uppercase', headingClass)}>
          {heading}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={handleCopy}
          aria-label={expected ? 'Copy skip reason' : 'Copy error message'}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      <pre
        className={cn('max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap', preClass)}
      >
        {error}
      </pre>
    </div>
  );
}
