'use client';

/**
 * ApprovalsTable — admin approval queue for paused workflow executions.
 *
 * Features:
 *   - Lists executions with status `paused_for_approval`.
 *   - Expandable rows to show approval context, trace, and input data.
 *   - Inline approve (with optional notes) and reject (with required reason).
 *   - Pagination with prev/next.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Loader2,
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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { FieldHelp } from '@/components/ui/field-help';
import { MarkdownContent } from '@/components/admin/orchestration/markdown-or-raw-view';
import { StructuredApprovalView } from '@/components/admin/orchestration/approvals/structured-approval-view';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parsePaginationMeta } from '@/lib/validations/common';
import { reviewSchemaSchema } from '@/lib/orchestration/review-schema/types';
import type { ReviewSchema } from '@/lib/orchestration/review-schema/types';
import { z } from 'zod';
import type { PaginationMeta } from '@/types/api';
import type { ExecutionListItem, ExecutionTraceEntry } from '@/types/orchestration';

const STRUCTURED_APPROVAL_WORKFLOW_SLUGS = new Set(['tpl-provider-model-audit']);

const apiErrorBodySchema = z
  .object({ error: z.object({ message: z.string().optional() }).optional() })
  .nullable();

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExecutionDetail {
  execution: {
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
    workflow: { id: string; name: string; slug: string };
  };
  trace: ExecutionTraceEntry[];
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ApprovalsTableProps {
  initialApprovals: ExecutionListItem[];
  initialMeta: PaginationMeta;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatWaitingTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ApprovalsTable({ initialApprovals, initialMeta }: ApprovalsTableProps) {
  const [approvals, setApprovals] = useState(initialApprovals);
  const [meta, setMeta] = useState(initialMeta);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Expand state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Approve state
  const [approveTarget, setApproveTarget] = useState<string | null>(null);
  const [approveNotes, setApproveNotes] = useState('');
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  // Structured-view-supplied payload; preserved into the confirm dialog so
  // the admin's per-item selection isn't lost when they click Approve.
  const [approvePayload, setApprovePayload] = useState<Record<string, unknown[]> | null>(null);

  // Reject state
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectLoading, setRejectLoading] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  // Success message
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  // ─── Fetch list ─────────────────────────────────────────────────────────

  const fetchApprovals = useCallback(
    async (page = 1) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
          status: 'paused_for_approval',
        });
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.EXECUTIONS}?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('fetch failed');
        const body = await parseApiResponse<ExecutionListItem[]>(res);
        if (!body.success) throw new Error('parse failed');
        setApprovals(body.data);
        const parsedMeta = parsePaginationMeta(body.meta);
        if (parsedMeta) setMeta(parsedMeta);
      } catch {
        setError('Could not load approvals. Try refreshing the page.');
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit]
  );

  // ─── Expand / collapse ─────────────────────────────────────────────────

  const handleToggleExpand = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        return;
      }

      setExpandedId(id);
      setDetail(null);
      setDetailLoading(true);
      setDetailError(null);

      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.executionById(id), {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('fetch failed');
        const body = await parseApiResponse<ExecutionDetail>(res);
        if (!body.success) throw new Error('parse failed');
        setDetail(body.data);
      } catch {
        setDetailError('Could not load execution details.');
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId]
  );

  // ─── Approve ────────────────────────────────────────────────────────────

  const handleApproveSubmit = useCallback(async () => {
    if (!approveTarget) return;
    setApproveLoading(true);
    setApproveError(null);

    try {
      const body: Record<string, unknown> = {};
      if (approveNotes) body.notes = approveNotes;
      if (approvePayload) body.approvalPayload = approvePayload;

      const res = await fetch(API.ADMIN.ORCHESTRATION.executionApprove(approveTarget), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = apiErrorBodySchema.safeParse(await res.json().catch(() => null));
        throw new Error((errBody.success && errBody.data?.error?.message) || 'Approve failed');
      }

      setApprovals((prev) => prev.filter((a) => a.id !== approveTarget));
      setMeta((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setApproveTarget(null);
      setApproveNotes('');
      setApprovePayload(null);
      setExpandedId(null);
      showSuccess('Execution approved. The workflow will resume.');
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setApproveLoading(false);
    }
  }, [approveTarget, approveNotes, approvePayload]);

  // ─── Reject ─────────────────────────────────────────────────────────────

  const handleRejectSubmit = useCallback(async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    setRejectLoading(true);
    setRejectError(null);

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.executionReject(rejectTarget), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (!res.ok) {
        const errBody = apiErrorBodySchema.safeParse(await res.json().catch(() => null));
        throw new Error((errBody.success && errBody.data?.error?.message) || 'Reject failed');
      }

      setApprovals((prev) => prev.filter((a) => a.id !== rejectTarget));
      setMeta((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setRejectTarget(null);
      setRejectReason('');
      setExpandedId(null);
      showSuccess('Execution rejected.');
    } catch (err) {
      setRejectError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setRejectLoading(false);
    }
  }, [rejectTarget, rejectReason]);

  function showSuccess(msg: string) {
    setSuccessMsg(msg);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setSuccessMsg(null), 4000);
  }

  // ─── Extract approval prompt from trace ─────────────────────────────────

  function getApprovalPrompt(trace: ExecutionTraceEntry[]): string | null {
    const entry = trace.find((e) => e.status === 'awaiting_approval');
    if (!entry?.output || typeof entry.output !== 'object') return null;
    const output = entry.output as Record<string, unknown>;
    return typeof output.prompt === 'string' ? output.prompt : null;
  }

  function getReviewSchema(trace: ExecutionTraceEntry[]): ReviewSchema | null {
    const entry = trace.find((e) => e.status === 'awaiting_approval');
    if (!entry?.output || typeof entry.output !== 'object') return null;
    const raw = (entry.output as Record<string, unknown>).reviewSchema;
    if (!raw) return null;
    const parsed = reviewSchemaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  function getPreviousSteps(trace: ExecutionTraceEntry[]): ExecutionTraceEntry[] {
    const idx = trace.findIndex((e) => e.status === 'awaiting_approval');
    return idx > 0 ? trace.slice(0, idx) : [];
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {successMsg && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          {successMsg}
        </div>
      )}

      {error && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>
                <Tip label="The workflow that triggered this execution">
                  <span>Workflow</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Truncated execution identifier — click to view full detail">
                  <span>Execution</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When the execution paused for approval">
                  <span>Paused</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Time elapsed since execution paused for approval">
                  <span>Waiting</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && approvals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : approvals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  <p className="text-muted-foreground">No executions awaiting approval.</p>
                  <Link
                    href="/admin/orchestration/executions"
                    className="text-primary mt-1 inline-block text-sm hover:underline"
                  >
                    View all executions
                  </Link>
                </TableCell>
              </TableRow>
            ) : (
              approvals.map((item) => (
                <Fragment key={item.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => void handleToggleExpand(item.id)}
                  >
                    <TableCell className="w-8">
                      {expandedId === item.id ? (
                        <ChevronUp className="text-muted-foreground h-4 w-4" />
                      ) : (
                        <ChevronDown className="text-muted-foreground h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/orchestration/workflows/${item.workflowId}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.workflow.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/admin/orchestration/executions/${item.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.id.slice(0, 8)}...
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1">
                        <Clock className="h-3 w-3" />
                        {formatWaitingTime(item.createdAt)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                      <div
                        className="flex items-center justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-green-700 hover:bg-green-50 hover:text-green-800 dark:text-green-400 dark:hover:bg-green-950 dark:hover:text-green-300"
                          onClick={() => {
                            setApproveTarget(item.id);
                            setApproveNotes('');
                            setApproveError(null);
                          }}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                          onClick={() => {
                            setRejectTarget(item.id);
                            setRejectReason('');
                            setRejectError(null);
                          }}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>

                  {/* Expanded detail row */}
                  {expandedId === item.id && (
                    <TableRow key={`${item.id}-detail`}>
                      <TableCell colSpan={6} className="bg-muted/30 p-4">
                        {detailLoading ? (
                          <div className="flex items-center justify-center py-6">
                            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                            <span className="text-muted-foreground ml-2 text-sm">
                              Loading details...
                            </span>
                          </div>
                        ) : detailError ? (
                          <div className="text-destructive py-4 text-center text-sm">
                            {detailError}
                          </div>
                        ) : detail ? (
                          (() => {
                            const reviewSchema = getReviewSchema(detail.trace);
                            const isStructured =
                              reviewSchema !== null &&
                              STRUCTURED_APPROVAL_WORKFLOW_SLUGS.has(
                                detail.execution.workflow.slug
                              );

                            if (isStructured) {
                              return (
                                <StructuredApprovalView
                                  trace={detail.trace}
                                  schema={reviewSchema}
                                  fallbackPrompt={getApprovalPrompt(detail.trace)}
                                  onRequestApprove={(payload) => {
                                    setApprovePayload(payload);
                                    setApproveTarget(item.id);
                                    setApproveNotes('');
                                    setApproveError(null);
                                  }}
                                  onRequestReject={() => {
                                    setRejectTarget(item.id);
                                    setRejectReason('');
                                    setRejectError(null);
                                  }}
                                  submitting={approveLoading || rejectLoading}
                                />
                              );
                            }

                            return (
                              <div className="space-y-4">
                                {/* Approval prompt — workflow authors write
                                    these in markdown, so render them as such
                                    (headings, lists, fenced code). MarkdownContent
                                    uses the same safe react-markdown config as
                                    the rest of the admin surface. */}
                                {getApprovalPrompt(detail.trace) && (
                                  <div className="rounded-md border bg-amber-50 p-3 dark:bg-amber-950">
                                    <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                                      Approval prompt{' '}
                                      <FieldHelp title="What is this?">
                                        The message configured in the workflow&apos;s human_approval
                                        step. It explains what the workflow has done so far and why
                                        it needs your review before continuing.
                                      </FieldHelp>
                                    </p>
                                    <MarkdownContent
                                      content={getApprovalPrompt(detail.trace) as string}
                                      className="mt-1 text-sm text-amber-900 dark:text-amber-100"
                                    />
                                  </div>
                                )}

                                {/* Cost summary */}
                                <div className="flex items-center gap-4 text-xs">
                                  <Tip label="Total LLM tokens consumed by this execution so far">
                                    <span className="text-muted-foreground">
                                      Tokens:{' '}
                                      <span className="text-foreground font-medium">
                                        {detail.execution.totalTokensUsed.toLocaleString()}
                                      </span>
                                    </span>
                                  </Tip>
                                  <Tip label="Cumulative LLM cost in USD for all steps so far">
                                    <span className="text-muted-foreground">
                                      Cost:{' '}
                                      <span className="text-foreground font-medium">
                                        ${detail.execution.totalCostUsd.toFixed(4)}
                                      </span>
                                    </span>
                                  </Tip>
                                  {detail.execution.budgetLimitUsd && (
                                    <Tip label="Maximum spend allowed for this execution before it is automatically halted">
                                      <span className="text-muted-foreground">
                                        Budget:{' '}
                                        <span className="text-foreground font-medium">
                                          ${detail.execution.budgetLimitUsd.toFixed(2)}
                                        </span>
                                      </span>
                                    </Tip>
                                  )}
                                </div>

                                {/* Previous steps */}
                                {getPreviousSteps(detail.trace).length > 0 && (
                                  <div>
                                    <p className="text-muted-foreground mb-2 text-xs font-medium">
                                      Completed steps before approval{' '}
                                      <FieldHelp title="Previous steps">
                                        The workflow steps that ran successfully before reaching the
                                        human_approval gate. Review these to understand what the
                                        workflow has already done and whether its outputs look
                                        correct.
                                      </FieldHelp>
                                    </p>
                                    <div className="space-y-1">
                                      {getPreviousSteps(detail.trace).map((step) => (
                                        <div
                                          key={step.stepId}
                                          className="bg-background flex items-center justify-between rounded border px-3 py-1.5 text-xs"
                                        >
                                          <span>
                                            <Badge variant="secondary" className="mr-2 text-[10px]">
                                              {step.stepType}
                                            </Badge>
                                            {step.label}
                                          </span>
                                          <span className="text-muted-foreground">
                                            {step.durationMs}ms
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Input data */}
                                {detail.execution.inputData != null &&
                                typeof detail.execution.inputData === 'object' &&
                                Object.keys(detail.execution.inputData as Record<string, unknown>)
                                  .length > 0 ? (
                                  <div>
                                    <p className="text-muted-foreground mb-1 text-xs font-medium">
                                      Input data{' '}
                                      <FieldHelp title="Execution input">
                                        The data passed to this workflow when it was triggered. This
                                        could include user queries, parameters from a scheduled run,
                                        or webhook payload data.
                                      </FieldHelp>
                                    </p>
                                    <pre className="bg-muted/40 max-h-40 overflow-auto rounded p-2 font-mono text-xs">
                                      {JSON.stringify(detail.execution.inputData, null, 2)}
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {meta.total === 0
            ? 'No pending approvals'
            : `${meta.total} pending approval${meta.total === 1 ? '' : 's'}`}
        </p>
        {meta.totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchApprovals(meta.page - 1)}
              disabled={meta.page <= 1 || isLoading}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchApprovals(meta.page + 1)}
              disabled={meta.page >= meta.totalPages || isLoading}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* ─── Approve Dialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApproveTarget(null);
            setApproveNotes('');
            setApprovePayload(null);
            setApproveError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve execution?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow will resume from where it paused. You can add optional notes for the
              audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approve-notes">
              Notes (optional){' '}
              <FieldHelp title="Approval notes">
                Optional context for why this execution was approved. Recorded in the audit trail
                for compliance and team visibility. Useful for noting any conditions or follow-up
                actions.
              </FieldHelp>
            </Label>
            <Textarea
              id="approve-notes"
              placeholder="Looks good, approved for production..."
              value={approveNotes}
              onChange={(e) => setApproveNotes(e.target.value)}
              rows={3}
            />
          </div>
          {approveError && <div className="text-destructive text-sm">{approveError}</div>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approveLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleApproveSubmit();
              }}
              disabled={approveLoading}
              className="bg-green-600 hover:bg-green-700"
            >
              {approveLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Reject Dialog ───────────────────────────────────────────────── */}
      <AlertDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectReason('');
            setRejectError(null);
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
            <Label htmlFor="reject-reason">
              Reason <span className="text-destructive">*</span>{' '}
              <FieldHelp title="Rejection reason">
                A clear explanation of why this execution is being rejected. This is stored in the
                execution&apos;s error message (prefixed with &quot;Rejected:&quot;) and recorded in
                the audit trail. The workflow will be permanently cancelled and cannot be resumed.
              </FieldHelp>
            </Label>
            <Textarea
              id="reject-reason"
              placeholder="Does not meet compliance requirements..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
            />
          </div>
          {rejectError && <div className="text-destructive text-sm">{rejectError}</div>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rejectLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRejectSubmit();
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
