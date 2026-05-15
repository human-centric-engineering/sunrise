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
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getStepMetadata } from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';
import { isMarkdown } from '@/lib/utils/is-markdown';
import { MarkdownOrRawView } from '@/components/admin/orchestration/markdown-or-raw-view';
import type { ExecutionTraceEntry } from '@/types/orchestration';

const RETRY_PILL_CLASS =
  'rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200';

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
  status: Status;
  output?: unknown;
  error?: string;
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
  /** Cost-log rows attributed to this step, for the per-call breakdown. */
  costEntries?: TraceCostEntry[];
  /**
   * Bounded-retry events emitted from this step. Rendered as amber
   * sub-rows so users can see at a glance which step looped, how many
   * attempts ran, and why each one failed.
   */
  retries?: ExecutionTraceEntry['retries'];
  /** When true, render with a highlighted background (used by timeline-strip clicks). */
  highlighted?: boolean;
  /** Fires when the user clicks "Retry" on a failed step. */
  onRetry?: (stepId: string) => void;
  /**
   * Parallel fan-out grouping. When this row is the fork step itself,
   * `forkNumber` is set. When this row is an immediate branch of a fork,
   * `parallelBranchOfNumber` carries the fork's number so the row can show
   * a "branch of fork #N" chip and a purple left-rail. Both are derived
   * via `buildParallelBranchMap` in the parent view.
   */
  forkNumber?: number;
  parallelBranchOfNumber?: number;
  /**
   * Controlled expand state. When provided, the row is in controlled mode
   * and the parent owns which entry is open — used to enforce
   * single-open accordion behaviour across the trace list. When omitted,
   * the row manages its own toggle locally (legacy behaviour).
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
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
  status,
  output,
  error,
  tokensUsed = 0,
  costUsd = 0,
  durationMs,
  input,
  model,
  provider,
  inputTokens,
  outputTokens,
  llmDurationMs,
  costEntries,
  retries,
  highlighted,
  onRetry,
  forkNumber,
  parallelBranchOfNumber,
  expanded: expandedProp,
  onExpandedChange,
}: ExecutionTraceEntryRowProps) {
  const [expandedInternal, setExpandedInternal] = useState(false);
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
        parallelBranchOfNumber !== undefined &&
          'border-l-4 border-l-purple-400 dark:border-l-purple-600'
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
            <span className="font-medium">{label}</span>
            <StepTypeChip stepId={stepId} stepType={stepType} />
            {forkNumber !== undefined && (
              <span
                data-testid={`trace-entry-fork-${stepId}`}
                className="flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-950/60 dark:text-purple-300"
                title="This step fans out concurrent branches"
              >
                <GitBranch className="h-3 w-3" />
                Parallel fork #{forkNumber}
              </span>
            )}
            {parallelBranchOfNumber !== undefined && (
              <span
                data-testid={`trace-entry-branch-${stepId}`}
                className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-950/60 dark:text-purple-300"
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
                {r.reason && <p className="mt-0.5 break-words opacity-80">Reason: {r.reason}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 border-t pt-2">
          {error && (
            <pre className="max-h-40 overflow-auto rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
              {error}
            </pre>
          )}
          {(input !== undefined || output !== undefined) && (
            <div className="grid gap-2 lg:grid-cols-2">
              {input !== undefined && input !== null && (
                <JsonPane label="Input" data={input} testId={`trace-entry-input-${stepId}`} />
              )}
              {output !== undefined && output !== null && (
                <JsonPane label="Output" data={output} testId={`trace-entry-output-${stepId}`} />
              )}
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

function StepTypeChip({ stepId, stepType }: { stepId: string; stepType: string }) {
  const meta = getStepMetadata(stepType);
  // Always render the chip; only attach a tooltip when we have a real
  // description from the registry. Unknown step types still render the
  // raw type string so admins aren't left with a missing chip.
  const chip = (
    <span
      data-testid={`trace-entry-step-type-${stepId}`}
      className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase"
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

function JsonPane({ label, data, testId }: { label: string; data: unknown; testId: string }) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const showMarkdown = isMarkdown(data);
  const [copied, setCopied] = useState(false);

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
    <div data-testid={testId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {label}
        </p>
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
      </div>
      {showMarkdown ? (
        <MarkdownOrRawView content={text} rawMaxHeightClass="max-h-60 overflow-y-auto" />
      ) : (
        <pre className="bg-muted/40 max-h-60 overflow-y-auto rounded p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}
