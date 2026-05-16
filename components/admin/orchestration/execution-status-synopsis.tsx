'use client';

/**
 * ExecutionStatusSynopsis — the "what went wrong" panel at the top of
 * the execution detail view.
 *
 * Renders nothing on clean completions. For non-success outcomes it
 * pre-digests the trace into three actionable surfaces:
 *
 *   - **Failure** (red): the headline step, the validator/executor
 *     reason, retry timeline, predecessor-step output snippet (what
 *     the failing step was looking at), and a skip tally line for
 *     mixed-outcome runs.
 *   - **Cancellation** (slate): the cancel reason and the step the
 *     engine was on when the cancel hit.
 *   - **Skips-only** (slate): an unexpected-skip-only summary for
 *     runs that completed but had one or more unintentional skips.
 *
 * The data analysis lives in `lib/orchestration/trace/synopsis.ts` so
 * the component itself is purely presentational — every conditional
 * here keys off the discriminated `SynopsisAnalysis` shape.
 *
 * Default-expand posture:
 *   - Failure → expanded by default (operator's first need)
 *   - Cancellation → collapsed (usually intentional; reason is on the
 *     summary line anyway)
 *   - Skips-only → collapsed (the run succeeded; skips are contextual)
 *
 * @see lib/orchestration/trace/synopsis.ts
 */

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RotateCcw,
  StopCircle,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JsonPretty } from '@/components/admin/orchestration/json-pretty';
import {
  analyzeExecution,
  type SynopsisAnalysis,
  type SynopsisExecution,
} from '@/lib/orchestration/trace/synopsis';
import { cn } from '@/lib/utils';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export interface ExecutionStatusSynopsisProps {
  execution: SynopsisExecution;
  trace: ExecutionTraceEntry[];
  /** Optional: clicking the headline step's "Jump to step" link calls
   * this. Wired to the same `setHighlightedStepId` handler the timeline
   * strip uses, so the synopsis and the strip stay in sync. */
  onJumpToStep?: (stepId: string) => void;
  /** Optional: surface a "Retry from this step" button next to the
   * headline. Same callback shape as `ExecutionTraceEntryRow.onRetry`. */
  onRetry?: (stepId: string) => void;
}

export function ExecutionStatusSynopsis({
  execution,
  trace,
  onJumpToStep,
  onRetry,
}: ExecutionStatusSynopsisProps) {
  const analysis = useMemo(
    () => analyzeExecution(execution, trace),
    // The trace array is replaced wholesale by the live-poll hook each
    // tick — referential equality is the right dep.
    [execution, trace]
  );

  if (analysis.kind === 'none') return null;
  if (analysis.kind === 'failure') {
    return <FailureSynopsis analysis={analysis} onJumpToStep={onJumpToStep} onRetry={onRetry} />;
  }
  if (analysis.kind === 'cancellation') {
    return <CancellationSynopsis analysis={analysis} onJumpToStep={onJumpToStep} />;
  }
  if (analysis.kind === 'skips_only') {
    return <SkipSynopsis analysis={analysis} onJumpToStep={onJumpToStep} />;
  }
  return null;
}

// ─── Failure variant ─────────────────────────────────────────────────────────

function FailureSynopsis({
  analysis,
  onJumpToStep,
  onRetry,
}: {
  analysis: Extract<SynopsisAnalysis, { kind: 'failure' }>;
  onJumpToStep?: (stepId: string) => void;
  onRetry?: (stepId: string) => void;
}) {
  // Failures default open — the synopsis is exactly what the operator
  // came to see. Collapsing is the manual "I've read it, get out of my
  // way" gesture.
  const [open, setOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);

  const { reason, headlineStep, retries, predecessor, skips, terminalAuthor } = analysis;
  const headlineText = makeHeadline(headlineStep, terminalAuthor);
  const reasonFirstLine = firstLine(reason);

  return (
    <section
      data-testid="execution-synopsis-failure"
      className="rounded-md border border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100"
    >
      <header className="flex items-start gap-3 p-4">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{headlineText}</h3>
            {headlineStep ? <StepTypeChip type={headlineStep.stepType} /> : null}
          </div>
          {!open && reasonFirstLine ? (
            <p
              className="text-foreground/80 mt-1 line-clamp-2 text-xs font-normal"
              data-testid="execution-synopsis-collapsed-reason"
            >
              {reasonFirstLine}
            </p>
          ) : null}
        </div>
        <ToggleButton open={open} onClick={() => setOpen((v) => !v)} variant="failure" />
      </header>

      {open ? (
        <div className="space-y-3 px-4 pt-1 pb-4">
          {/* Cause chain — only when the headline failure was authored
              by a downstream terminalStatus step rather than the
              culprit itself. Makes the "exhausted at X → finalised via
              Y" relationship explicit. */}
          {terminalAuthor && headlineStep ? (
            <p className="text-foreground/80 text-xs" data-testid="execution-synopsis-cause-chain">
              Retry budget exhausted at <strong>{headlineStep.label}</strong> → workflow terminated
              via <strong>{terminalAuthor.label}</strong>.
            </p>
          ) : null}

          {/* Reason block — full text, copyable. */}
          <ReasonBlock reason={reason} />

          {/* Retry timeline. */}
          {retries.length > 0 ? <RetryTimeline retries={retries} /> : null}

          {/* Predecessor output: what the failing step was looking at. */}
          {predecessor ? (
            <PredecessorBlock
              predecessor={predecessor}
              open={contextOpen}
              onToggle={() => setContextOpen((v) => !v)}
            />
          ) : null}

          {/* Skip tally inside a failure surface — only when there ARE
              unexpected skips alongside the failure. Expected skips on a
              failed run are noise and we omit them. */}
          {skips.unexpected.length > 0 ? (
            <p className="text-foreground/75 text-xs">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-text-top" />
              {skips.unexpected.length} unexpected{' '}
              {skips.unexpected.length === 1 ? 'skip' : 'skips'} during this run — see the step
              timeline for details.
            </p>
          ) : null}

          {/* Action row: jump to step + retry. */}
          {headlineStep && (onJumpToStep || onRetry) ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {onJumpToStep ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 border-red-300 text-red-900 hover:bg-red-100 dark:border-red-800 dark:text-red-100 dark:hover:bg-red-900/40"
                  onClick={() => onJumpToStep(headlineStep.stepId)}
                  data-testid="execution-synopsis-jump"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                  Jump to step
                </Button>
              ) : null}
              {onRetry ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 border-red-300 text-red-900 hover:bg-red-100 dark:border-red-800 dark:text-red-100 dark:hover:bg-red-900/40"
                  onClick={() => onRetry(headlineStep.stepId)}
                  data-testid="execution-synopsis-retry"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry from this step
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Cancellation variant ───────────────────────────────────────────────────

function CancellationSynopsis({
  analysis,
  onJumpToStep,
}: {
  analysis: Extract<SynopsisAnalysis, { kind: 'cancellation' }>;
  onJumpToStep?: (stepId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { reason, atStep } = analysis;

  return (
    <section
      data-testid="execution-synopsis-cancellation"
      className="bg-muted/40 rounded-md border"
    >
      <header className="flex items-start gap-3 p-4">
        <StopCircle className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Cancelled</h3>
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{firstLine(reason)}</p>
        </div>
        <ToggleButton open={open} onClick={() => setOpen((v) => !v)} variant="muted" />
      </header>

      {open ? (
        <div className="space-y-3 px-4 pb-4">
          <ReasonBlock reason={reason} tone="muted" />
          {atStep ? (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span>Cancellation hit at</span>
              <strong className="text-foreground">{atStep.label}</strong>
              <StepTypeChip type={atStep.stepType} />
              {onJumpToStep ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => onJumpToStep(atStep.stepId)}
                  data-testid="execution-synopsis-jump"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                  Jump to step
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ─── Skips-only variant ─────────────────────────────────────────────────────

function SkipSynopsis({
  analysis,
  onJumpToStep,
}: {
  analysis: Extract<SynopsisAnalysis, { kind: 'skips_only' }>;
  onJumpToStep?: (stepId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { unexpected, expected } = analysis.skips;
  const summary =
    expected.length > 0
      ? `${unexpected.length} unexpected ${unexpected.length === 1 ? 'skip' : 'skips'} (${expected.length} expected)`
      : `${unexpected.length} unexpected ${unexpected.length === 1 ? 'skip' : 'skips'}`;

  return (
    <section
      data-testid="execution-synopsis-skips"
      className="rounded-md border border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <header className="flex items-start gap-3 p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Completed with skipped steps</h3>
          <p className="text-foreground/80 mt-0.5 text-xs">{summary}</p>
        </div>
        <ToggleButton open={open} onClick={() => setOpen((v) => !v)} variant="amber" />
      </header>

      {open ? (
        <ul className="space-y-2 px-4 pb-4" data-testid="execution-synopsis-skip-list">
          {unexpected.map((entry) => (
            <SkippedStepRow
              key={entry.stepId}
              entry={entry}
              tone="unexpected"
              onJumpToStep={onJumpToStep}
            />
          ))}
          {expected.map((entry) => (
            <SkippedStepRow
              key={entry.stepId}
              entry={entry}
              tone="expected"
              onJumpToStep={onJumpToStep}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────────

function ToggleButton({
  open,
  onClick,
  variant,
}: {
  open: boolean;
  onClick: () => void;
  variant: 'failure' | 'muted' | 'amber';
}) {
  const colour =
    variant === 'failure'
      ? 'text-red-700 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/40'
      : variant === 'amber'
        ? 'text-amber-700 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40'
        : 'text-muted-foreground hover:bg-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded px-2 text-xs font-medium',
        colour
      )}
      aria-expanded={open}
      data-testid="execution-synopsis-toggle"
    >
      {open ? (
        <>
          <ChevronDown className="h-3.5 w-3.5" />
          Hide
        </>
      ) : (
        <>
          <ChevronRight className="h-3.5 w-3.5" />
          Show details
        </>
      )}
    </button>
  );
}

function ReasonBlock({ reason, tone = 'failure' }: { reason: string; tone?: 'failure' | 'muted' }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void (async () => {
      try {
        await navigator.clipboard.writeText(reason);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard may be unavailable in non-secure contexts; ignore.
      }
    })();
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-foreground/70 text-[11px] font-medium tracking-wide uppercase">Reason</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-foreground/70 hover:text-foreground h-6 gap-1 px-1.5 text-[11px]"
          onClick={handleCopy}
          aria-label="Copy reason"
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
        className={cn(
          'overflow-x-auto rounded p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap',
          tone === 'failure' ? 'bg-red-100/70 dark:bg-red-950/40' : 'bg-muted/70 dark:bg-muted/30'
        )}
        data-testid="execution-synopsis-reason"
      >
        {reason}
      </pre>
    </div>
  );
}

function RetryTimeline({ retries }: { retries: NonNullable<ExecutionTraceEntry['retries']> }) {
  return (
    <div data-testid="execution-synopsis-retries">
      <p className="text-foreground/70 mb-1 text-[11px] font-medium tracking-wide uppercase">
        Retry history ({retries.length} {retries.length === 1 ? 'event' : 'events'})
      </p>
      <ol className="space-y-1.5">
        {retries.map((r, i) => (
          <li
            key={i}
            className={cn(
              'flex items-start gap-2 rounded border border-dashed px-2 py-1.5 text-xs',
              r.exhausted
                ? 'border-red-300 bg-red-100/70 dark:border-red-700 dark:bg-red-950/40'
                : 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30'
            )}
          >
            <RotateCcw
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
                r.exhausted
                  ? 'text-red-700 dark:text-red-300'
                  : 'text-amber-700 dark:text-amber-300'
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {r.exhausted
                  ? `Retry budget exhausted (attempt ${r.attempt} of ${r.maxRetries}) → routed to ${r.targetStepId}`
                  : `Attempt ${r.attempt} of ${r.maxRetries} → ${r.targetStepId}`}
              </p>
              {r.reason ? (
                <p className="text-foreground/75 mt-0.5 break-words">{r.reason}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PredecessorBlock({
  predecessor,
  open,
  onToggle,
}: {
  predecessor: { stepId: string; stepName: string; output: unknown };
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="text-foreground/70 hover:text-foreground flex items-center gap-1 text-[11px] font-medium tracking-wide uppercase"
        aria-expanded={open}
        data-testid="execution-synopsis-context-toggle"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        What this step was looking at — {predecessor.stepName}
      </button>
      {open ? (
        <div className="mt-1.5" data-testid="execution-synopsis-context">
          <JsonPretty
            data={predecessor.output}
            className="bg-background/50 max-h-60 overflow-y-auto rounded p-2"
          />
        </div>
      ) : null}
    </div>
  );
}

function SkippedStepRow({
  entry,
  tone,
  onJumpToStep,
}: {
  entry: ExecutionTraceEntry;
  tone: 'expected' | 'unexpected';
  onJumpToStep?: (stepId: string) => void;
}) {
  return (
    <li
      className="flex items-start gap-2 text-xs"
      data-testid={`execution-synopsis-skip-${entry.stepId}`}
    >
      <Badge
        variant="outline"
        className={cn(
          'shrink-0 text-[10px]',
          tone === 'expected'
            ? 'border-amber-300/60 bg-amber-100/40 text-amber-900/80 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200/80'
            : 'border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100'
        )}
      >
        {tone === 'expected' ? 'expected' : 'unexpected'}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {entry.label}
          <span className="text-foreground/60 ml-2 font-mono text-[10px]">{entry.stepType}</span>
        </p>
        {entry.error ? (
          <p className="text-foreground/75 mt-0.5 break-words">{entry.error}</p>
        ) : (
          <p className="text-foreground/60 mt-0.5 italic">no reason captured</p>
        )}
      </div>
      {onJumpToStep ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => onJumpToStep(entry.stepId)}
        >
          <ChevronRight className="h-3 w-3" />
          Step
        </Button>
      ) : null}
    </li>
  );
}

function StepTypeChip({ type }: { type: string }) {
  return (
    <span className="bg-background/70 text-foreground/70 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase">
      {type}
    </span>
  );
}

// ─── Pure presentation helpers ──────────────────────────────────────────────

function makeHeadline(
  headlineStep: ExecutionTraceEntry | null,
  terminalAuthor: ExecutionTraceEntry | null
): string {
  if (!headlineStep) return 'Workflow failed';
  if (terminalAuthor) {
    // Retry-exhaustion case — the headline is the culprit, not the
    // terminalStatus author. The cause-chain row in the body explains
    // the relationship.
    return `Failed: retries exhausted at "${headlineStep.label}"`;
  }
  return `Failed at "${headlineStep.label}"`;
}

function firstLine(text: string): string {
  const t = text.trim();
  const nl = t.indexOf('\n');
  if (nl === -1) return t;
  return t.slice(0, nl).trim();
}
