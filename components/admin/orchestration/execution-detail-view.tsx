'use client';

/**
 * ExecutionDetailView (Phase 7 Session 7.2)
 *
 * Client component that renders a workflow execution's summary,
 * error banner, input/output cards, and step timeline. Reuses the
 * existing `ExecutionTraceEntryRow` for each trace entry.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/utils/format-duration';
import { formatStatus } from '@/lib/utils/format-status';
import { ExecutionTraceEntryRow } from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';
import type { ExecutionTraceEntry } from '@/types/orchestration';
import { z } from 'zod';

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

export interface ExecutionDetailViewProps {
  execution: ExecutionInfo;
  trace: ExecutionTraceEntry[];
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

  if (data === null || data === undefined) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
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

function getApprovalPrompt(trace: ExecutionTraceEntry[]): string | null {
  const entry = trace.find((e) => e.status === 'awaiting_approval');
  if (!entry?.output) return null;
  const parsed = z.object({ prompt: z.string() }).safeParse(entry.output);
  return parsed.success ? parsed.data.prompt : null;
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ExecutionDetailView({ execution, trace }: ExecutionDetailViewProps) {
  const router = useRouter();
  const duration = formatDuration(execution.startedAt, execution.completedAt);
  const budgetUsed =
    execution.budgetLimitUsd && execution.budgetLimitUsd > 0
      ? (execution.totalCostUsd / execution.budgetLimitUsd) * 100
      : null;

  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

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

  const canCancel = execution.status === 'running' || execution.status === 'paused_for_approval';
  const canApprove = execution.status === 'paused_for_approval';
  const canRetry = execution.status === 'failed';
  const failedStepId = canRetry ? trace.find((e) => e.status === 'failed')?.stepId : undefined;

  // Extract approval prompt from awaiting trace entry
  const approvalPrompt = canApprove ? getApprovalPrompt(trace) : null;

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

      {/* Approval prompt card */}
      {approvalPrompt && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Approval prompt</p>
          <p className="mt-1 text-sm text-amber-900 dark:text-amber-100">{approvalPrompt}</p>
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
            <CardTitle className="text-xs font-medium">
              Total Cost{' '}
              <FieldHelp title="How cost is calculated">
                Each LLM step reports its token cost based on the provider&apos;s pricing. The total
                here is the sum across all steps. Non-LLM steps (guards, external calls) report $0.
              </FieldHelp>
            </CardTitle>
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
            {trace.map((entry, idx) => (
              <ExecutionTraceEntryRow
                key={`${entry.stepId}-${idx}`}
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
