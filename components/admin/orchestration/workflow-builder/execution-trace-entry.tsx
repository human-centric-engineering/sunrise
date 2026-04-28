'use client';

/**
 * ExecutionTraceEntryRow — one row in the live execution panel's
 * timeline. Renders a step's status pill, label, duration, tokens/cost,
 * and a collapsible output payload.
 */

import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ExecutionTraceEntry } from '@/types/orchestration';

type Status = ExecutionTraceEntry['status'] | 'running';

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
  /** Fires when the user clicks "Retry" on a failed step. */
  onRetry?: (stepId: string) => void;
}

const STATUS_STYLES: Record<Status, { icon: React.ElementType; colour: string; text: string }> = {
  running: { icon: Loader2, colour: 'text-blue-500', text: 'Running' },
  completed: { icon: CheckCircle2, colour: 'text-green-500', text: 'Completed' },
  failed: { icon: XCircle, colour: 'text-red-500', text: 'Failed' },
  skipped: { icon: ChevronRight, colour: 'text-muted-foreground', text: 'Skipped' },
  awaiting_approval: { icon: Clock, colour: 'text-amber-500', text: 'Awaiting approval' },
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
  onRetry,
}: ExecutionTraceEntryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  const animate = status === 'running' ? 'animate-spin' : '';

  return (
    <div
      data-testid={`trace-entry-${stepId}`}
      className="border-border/60 rounded-md border p-3 text-sm"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
      >
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.colour, animate)} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground text-xs">{stepType}</span>
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span>{style.text}</span>
            {typeof durationMs === 'number' && <span>{durationMs} ms</span>}
            {tokensUsed > 0 && <span>{tokensUsed.toLocaleString()} tokens</span>}
            {costUsd > 0 && <span>${costUsd.toFixed(4)}</span>}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-4 w-4" />
        ) : (
          <ChevronRight className="text-muted-foreground h-4 w-4" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-t pt-2">
          {error && (
            <pre className="max-h-40 overflow-auto rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
              {error}
            </pre>
          )}
          {output !== undefined && output !== null && (
            <pre className="bg-muted/40 max-h-60 overflow-auto rounded p-2 font-mono text-xs">
              {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
            </pre>
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
