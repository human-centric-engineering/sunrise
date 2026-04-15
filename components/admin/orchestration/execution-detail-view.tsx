'use client';

/**
 * ExecutionDetailView (Phase 7 Session 7.2)
 *
 * Client component that renders a workflow execution's summary,
 * error banner, input/output cards, and step timeline. Reuses the
 * existing `ExecutionTraceEntryRow` for each trace entry.
 */

import { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { ExecutionTraceEntryRow } from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionInfo {
  id: string;
  workflowId: string;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  budgetLimitUsd: number | null;
  currentStep: number | null;
  inputData: unknown;
  outputData: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ExecutionDetailViewProps {
  execution: ExecutionInfo;
  trace: ExecutionTraceEntry[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  completed: 'default',
  running: 'secondary',
  pending: 'outline',
  failed: 'destructive',
  paused_for_approval: 'secondary',
};

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start)) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Collapsible JSON card ──────────────────────────────────────────────────

function CollapsibleJsonCard({ title, data }: { title: string; data: unknown }) {
  const [open, setOpen] = useState(false);

  if (data === null || data === undefined) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="text-muted-foreground h-4 w-4" />
          ) : (
            <ChevronRight className="text-muted-foreground h-4 w-4" />
          )}
          <CardTitle className="text-sm">{title}</CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          <pre className="bg-muted/40 overflow-x-auto rounded p-2 font-mono text-xs">
            {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ExecutionDetailView({ execution, trace }: ExecutionDetailViewProps) {
  const duration = formatDuration(execution.startedAt, execution.completedAt);
  const budgetUsed =
    execution.budgetLimitUsd && execution.budgetLimitUsd > 0
      ? (execution.totalCostUsd / execution.budgetLimitUsd) * 100
      : null;

  return (
    <div className="space-y-6">
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
                <strong>Paused for approval</strong> — waiting for a human to approve a capability
                call.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={STATUS_BADGE[execution.status] ?? 'outline'}>
              {formatStatus(execution.status)}
            </Badge>
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
            <span className="text-lg font-bold">{execution.totalTokensUsed.toLocaleString()}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-bold">${execution.totalCostUsd.toFixed(4)}</span>
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
            <CardTitle className="text-xs font-medium">Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-bold">{duration ?? '—'}</span>
          </CardContent>
        </Card>
      </div>

      {/* Error banner */}
      {execution.errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
            {execution.errorMessage}
          </pre>
        </div>
      )}

      {/* Input / Output cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CollapsibleJsonCard title="Input Data" data={execution.inputData} />
        <CollapsibleJsonCard title="Output Data" data={execution.outputData} />
      </div>

      {/* Step timeline */}
      <section aria-label="Execution trace">
        <h2 className="mb-3 text-lg font-semibold">Step Timeline</h2>
        {trace.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">No trace entries recorded.</p>
        ) : (
          <div className="space-y-2">
            {trace.map((entry) => (
              <ExecutionTraceEntryRow
                key={entry.stepId}
                stepId={entry.stepId}
                stepType={entry.stepType}
                label={entry.label}
                status={entry.status}
                output={entry.output}
                error={entry.error}
                tokensUsed={entry.tokensUsed}
                costUsd={entry.costUsd}
                durationMs={entry.durationMs}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
