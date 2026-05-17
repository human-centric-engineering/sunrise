'use client';

/**
 * ExecutionProgressInline — compact live-progress panel for an
 * orchestration execution, designed to embed inside another container
 * (e.g. the Audit Models dialog) without dragging in the full
 * `ExecutionDetailView` page chrome.
 *
 * Renders, top to bottom:
 *   - A single status row (status pill, current step label, wall-clock,
 *     tokens, cost).
 *   - The existing `ExecutionTimelineStrip` Gantt chart, which is
 *     already container-agnostic.
 *   - When the run is paused for approval: an inline approval card
 *     with the prompt rendered as markdown, plus notes/reason inputs
 *     and approve/reject buttons. The buttons hit the standard admin
 *     endpoints and never need a structured payload from this surface
 *     — the per-model audit payload UX lives elsewhere.
 *
 * Polling, retry, and visibility-pause behaviour are inherited from
 * `useExecutionLivePoll`. The caller seeds an initial payload (from
 * the response of the "execute workflow" POST or the page's RSC
 * fetch) so the first paint isn't blank.
 */

import { useCallback, useState, type ReactElement } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronRight, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  useExecutionLivePoll,
  isTerminalStatus,
  type ExecutionLivePayload,
} from '@/lib/hooks/use-execution-live-poll';
import { ExecutionTimelineStrip } from '@/components/admin/orchestration/execution-timeline-strip';
import { MarkdownContent } from '@/components/admin/orchestration/markdown-or-raw-view';
import { getApprovalPrompt } from '@/lib/orchestration/trace/approval-prompt';
import { formatStatus } from '@/lib/utils/format-status';
import { cn } from '@/lib/utils';

const STATUS_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  cancelled: 'outline',
  paused_for_approval: 'outline',
  pending: 'outline',
};

export interface ExecutionProgressInlineProps {
  executionId: string;
  /** Seed for the first paint — typically the response of the execute POST. */
  initialPayload: ExecutionLivePayload;
  /** Fires once when the run transitions to a terminal status. */
  onTerminal?: (status: string) => void;
  /** Fires after a successful inline approve / reject. */
  onApproved?: () => void;
  onRejected?: () => void;
  /** Optional className for the outer container. */
  className?: string;
}

export function ExecutionProgressInline({
  executionId,
  initialPayload,
  onTerminal,
  onApproved,
  onRejected,
  className,
}: ExecutionProgressInlineProps): ReactElement {
  const live = useExecutionLivePoll(executionId, initialPayload);
  const status = live.snapshot.status;
  const terminal = isTerminalStatus(status);

  // Wall-clock format: fast, lossy, and always rendered (running runs
  // have no completedAt — `formatWallClock` substitutes "now").
  const wallClock = formatWallClock(live.snapshot.startedAt, live.snapshot.completedAt);

  // Drive the parent's terminal callback at most once per mount.
  const [terminalNotified, setTerminalNotified] = useState(false);
  if (terminal && !terminalNotified) {
    setTerminalNotified(true);
    queueMicrotask(() => onTerminal?.(status));
  }

  const approvalPrompt = status === 'paused_for_approval' ? getApprovalPrompt(live.trace) : null;

  return (
    <div className={cn('space-y-3', className)} data-testid="execution-progress-inline">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={STATUS_BADGE_VARIANT[status] ?? 'outline'}>{formatStatus(status)}</Badge>
        {live.currentStepDetails && !terminal && (
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="font-mono text-xs">{live.currentStepDetails.label}</span>
          </span>
        )}
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {wallClock}
          </span>
          {live.snapshot.totalTokensUsed > 0 && (
            <span>{live.snapshot.totalTokensUsed.toLocaleString()} tokens</span>
          )}
          {live.snapshot.totalCostUsd > 0 && <span>${live.snapshot.totalCostUsd.toFixed(4)}</span>}
        </span>
      </div>

      {/* Error banner — terminal failure */}
      {status === 'failed' && live.snapshot.errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{live.snapshot.errorMessage}</span>
        </div>
      )}

      {/* Timeline strip (hides itself when trace.length < 2) */}
      <ExecutionTimelineStrip trace={live.trace} />

      {/* Inline approval card */}
      {status === 'paused_for_approval' && (
        <ApprovalInlineCard
          executionId={executionId}
          prompt={approvalPrompt}
          onApproved={onApproved}
          onRejected={onRejected}
        />
      )}

      {/* "View full details" link — always present so the operator
          can escape to the canonical detail page at any point. */}
      <div className="flex justify-end">
        <Link
          href={`/admin/orchestration/executions/${executionId}`}
          className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
        >
          View full details
          <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

// ─── Approval card ──────────────────────────────────────────────────────────

function ApprovalInlineCard({
  executionId,
  prompt,
  onApproved,
  onRejected,
}: {
  executionId: string;
  prompt: string | null;
  onApproved?: () => void;
  onRejected?: () => void;
}): ReactElement {
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitApprove = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionApprove(executionId), {
        body: { notes: notes.trim() || undefined },
      });
      onApproved?.();
      // Reset local state; the live poll will reflect the resume.
      setMode('idle');
      setNotes('');
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Approval failed — try again or refresh.'
      );
    } finally {
      setSubmitting(false);
    }
  }, [executionId, notes, onApproved]);

  const submitReject = useCallback(async () => {
    if (!reason.trim()) {
      setError('A reason is required when rejecting.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionReject(executionId), {
        body: { reason: reason.trim() },
      });
      onRejected?.();
      setMode('idle');
      setReason('');
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Rejection failed — try again or refresh.'
      );
    } finally {
      setSubmitting(false);
    }
  }, [executionId, reason, onRejected]);

  return (
    <div
      data-testid="execution-progress-inline-approval"
      className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
    >
      <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Approval required</p>
      {prompt ? (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border border-amber-200/60 bg-white/60 p-2 dark:border-amber-900/60 dark:bg-amber-950/30">
          <MarkdownContent
            content={prompt}
            className="text-sm text-amber-900 dark:text-amber-100"
          />
        </div>
      ) : (
        <p className="text-muted-foreground mt-1 text-sm italic">
          (No prompt captured — review the trace or open full details.)
        </p>
      )}

      {mode === 'approve' && (
        <div className="mt-3 space-y-2">
          <Label htmlFor="inline-approve-notes" className="text-xs">
            Notes (optional){' '}
            <FieldHelp title="Approval notes">
              Optional context for why this execution was approved. Recorded in the audit trail for
              compliance and team visibility. Useful for noting any conditions or follow-up actions.
            </FieldHelp>
          </Label>
          <Textarea
            id="inline-approve-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional context for the audit trail…"
            rows={2}
            disabled={submitting}
          />
        </div>
      )}
      {mode === 'reject' && (
        <div className="mt-3 space-y-2">
          <Label htmlFor="inline-reject-reason" className="text-xs">
            Reason (required){' '}
            <FieldHelp title="Rejection reason">
              A clear explanation of why this execution is being rejected. This is stored in the
              execution&apos;s error message (prefixed with &quot;Rejected:&quot;) and recorded in
              the audit trail. The workflow will be permanently cancelled and cannot be resumed.
            </FieldHelp>
          </Label>
          <Textarea
            id="inline-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this rejected? Recorded as the cancellation reason."
            rows={2}
            disabled={submitting}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode === 'idle' ? (
          <>
            <Button
              type="button"
              size="sm"
              onClick={() => setMode('approve')}
              className="bg-green-600 hover:bg-green-700"
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMode('reject')}
              className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300"
            >
              <XCircle className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
            <Link
              href="/admin/orchestration/approvals"
              className="text-muted-foreground ml-auto inline-flex items-center gap-1 text-xs hover:underline"
            >
              Open in full view
              <ExternalLink className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode('idle');
                setError(null);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void (mode === 'approve' ? submitApprove() : submitReject())}
              disabled={submitting}
              className={
                mode === 'approve'
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-red-600 hover:bg-red-700'
              }
            >
              {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Confirm {mode === 'approve' ? 'approval' : 'rejection'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatWallClock(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start)) return '—';
  const ms = Math.max(0, end - start);
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
