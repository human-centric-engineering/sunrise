'use client';

/**
 * ApprovalCard — in-chat Approve / Reject card surfacing a paused
 * `human_approval` step from a workflow the agent triggered via the
 * `run_workflow` capability. Mounted on assistant messages whose
 * `metadata.pendingApproval` is set.
 *
 * State machine:
 *   idle → submitting → waiting → completed | failed | expired
 *
 * Approve / Reject POSTs hit the channel-specific token endpoint
 * (`…/approve/chat`, `…/reject/chat`). The actorLabel is set
 * server-side; we never claim it from the client. After a successful
 * decision, the card polls the execution row to a terminal state and
 * synthesises a follow-up user message that carries the workflow
 * output back into the conversation, so the LLM gets a fresh turn to
 * summarise the outcome.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';
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
import { SaveError } from '@/components/forms/form-error';
import { apiErrorFromResponse } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useTimeout } from '@/lib/hooks/use-timeout';
import {
  extractFinalOutput,
  reducer,
  safeStringify,
} from '@/components/admin/orchestration/chat/approval-card-helpers';
import type { PendingApproval } from '@/types/orchestration';

const POLL_BASE_MS = 2_000;
const POLL_MAX_MS = 5_000;
const POLL_BUDGET_MS = 5 * 60 * 1_000; // 5 minutes

export interface ApprovalCardProps {
  pendingApproval: PendingApproval;
  /**
   * Called when the workflow reaches a terminal state. The follow-up
   * message is sent through the chat surface as a synthetic user
   * message so the LLM gets a fresh turn carrying the workflow output.
   */
  onResolved: (action: 'approved' | 'rejected', followupMessage: string) => void;
}

interface ExecutionResponse {
  data?: {
    status?: string;
    errorMessage?: string | null;
    executionTrace?: unknown;
  };
}

export function ApprovalCard({ pendingApproval, onResolved }: ApprovalCardProps) {
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);
  // The decision being sent. Its dialog stays open until the server accepts
  // it, and shows a refusal inside it (§124).
  const [sending, setSending] = useState<'approve' | 'reject' | null>(null);
  const approveSave = useSaveFailure({
    fallback: 'Could not send the approval. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const rejectSave = useSaveFailure({
    fallback: 'Could not send the rejection. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const { clear: clearApproveSave, report: reportApproveSave } = approveSave;
  const { clear: clearRejectSave, report: reportRejectSave } = rejectSave;

  const pollAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const schedule = useTimeout();

  // Cancel any in-flight network on unmount.
  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
      submitAbortRef.current?.abort();
    };
  }, []);

  const startPolling = useCallback(
    (action: 'approve' | 'reject') => {
      const controller = new AbortController();
      pollAbortRef.current = controller;
      const startedAt = Date.now();
      let attempt = 0;

      const tick = async (): Promise<void> => {
        if (controller.signal.aborted) return;
        if (Date.now() - startedAt > POLL_BUDGET_MS) {
          dispatch({ type: 'poll_expired' });
          return;
        }
        try {
          // Poll the public token-auth status endpoint (not the admin
          // executions endpoint). The admin endpoint wraps execution
          // fields under `data.execution.*` and the trace under
          // `data.trace`, but this card reads `data.status` /
          // `data.executionTrace` directly — the flat shape the public
          // /approvals/:id/status endpoint already returns. Same
          // endpoint the embed widget polls, so the contract is shared
          // across surfaces.
          const statusUrl = `${API.ORCHESTRATION.approvalStatus(pendingApproval.executionId)}?token=${encodeURIComponent(pendingApproval.approveToken)}`;
          const res = await fetch(statusUrl, { signal: controller.signal });
          if (!res.ok) throw new Error(`Execution status fetch failed (${res.status})`);
          const json = (await res.json()) as ExecutionResponse;
          const status = json.data?.status;

          if (status === 'completed') {
            const output = extractFinalOutput(json.data?.executionTrace);
            const rendered = safeStringify(output);
            const followup =
              rendered.length > 0
                ? `Workflow approved. Result: ${rendered}`
                : 'Workflow approved successfully.';
            dispatch({ type: 'poll_completed' });
            onResolved('approved', followup);
            return;
          }
          if (status === 'cancelled' || status === 'failed') {
            const reason = json.data?.errorMessage ?? 'Workflow ended';
            const followup =
              action === 'reject' ? `Workflow rejected: ${reason}` : `Workflow failed: ${reason}`;
            dispatch({
              type: action === 'reject' ? 'poll_completed' : 'poll_failed',
              payload: { message: reason },
            });
            onResolved(action === 'reject' ? 'rejected' : 'approved', followup);
            return;
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;
          // Transient errors are retried until the budget expires.
        }
        attempt += 1;
        const delay = Math.min(POLL_BASE_MS * Math.pow(1.5, attempt - 1), POLL_MAX_MS);
        schedule(() => void tick(), delay);
      };

      void tick();
    },
    [pendingApproval.executionId, pendingApproval.approveToken, onResolved, schedule]
  );

  /** Sends the decision; true once the server accepted it. */
  const submit = useCallback(
    async (action: 'approve' | 'reject', body: Record<string, unknown>): Promise<boolean> => {
      submitAbortRef.current?.abort();
      const controller = new AbortController();
      submitAbortRef.current = controller;

      try {
        const url =
          action === 'approve'
            ? API.ORCHESTRATION.approvalApproveChat(pendingApproval.executionId)
            : API.ORCHESTRATION.approvalRejectChat(pendingApproval.executionId);
        const token =
          action === 'approve' ? pendingApproval.approveToken : pendingApproval.rejectToken;
        const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw await apiErrorFromResponse(res);
        dispatch({ type: action === 'approve' ? 'approve_submit' : 'reject_submit' });
        dispatch({ type: 'submit_ok' });
        startPolling(action);
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return false;
        if (action === 'approve') reportApproveSave(err);
        else reportRejectSave(err);
        return false;
      }
    },
    [
      pendingApproval.executionId,
      pendingApproval.approveToken,
      pendingApproval.rejectToken,
      startPolling,
      reportApproveSave,
      reportRejectSave,
    ]
  );

  const handleApprove = useCallback(async () => {
    clearApproveSave();
    setSending('approve');
    const ok = await submit('approve', approveNotes ? { notes: approveNotes } : {});
    setSending(null);
    if (ok) setApproveOpen(false);
  }, [submit, approveNotes, clearApproveSave]);

  const handleReject = useCallback(async () => {
    if (!rejectReason.trim()) return;
    clearRejectSave();
    setSending('reject');
    const ok = await submit('reject', { reason: rejectReason.trim() });
    setSending(null);
    if (ok) setRejectOpen(false);
  }, [submit, rejectReason, clearRejectSave]);

  const expired = state.kind === 'expired';
  const failed = state.kind === 'failed';
  const busy = state.kind === 'submitting' || state.kind === 'waiting';

  return (
    <div
      role="region"
      aria-label="Action requires approval"
      aria-live="polite"
      className="border-border bg-muted/40 mt-2 rounded-md border p-3 text-sm"
    >
      <div className="font-medium">Action requires your approval</div>
      <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{pendingApproval.prompt}</p>

      {state.kind === 'idle' && (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => setApproveOpen(true)}
            aria-label="Approve action"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRejectOpen(true)}
            aria-label="Reject action"
          >
            <X className="mr-2 h-4 w-4" />
            Reject
          </Button>
        </div>
      )}

      {(busy || sending) && (
        <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>
            {sending
              ? `Submitting ${sending === 'approve' ? 'approval' : 'rejection'}…`
              : state.kind === 'submitting'
                ? `Submitting ${state.action === 'approve' ? 'approval' : 'rejection'}…`
                : 'Waiting for the workflow to finish…'}
          </span>
        </div>
      )}

      {state.kind === 'completed' && (
        <div className="text-muted-foreground mt-3 text-xs">
          {state.action === 'reject'
            ? 'Rejected — workflow cancelled.'
            : 'Approved — workflow completed.'}
        </div>
      )}

      {failed && state.kind === 'failed' && (
        <div className="text-destructive mt-3 text-xs">Failed: {state.message}</div>
      )}

      {expired && (
        <div className="text-muted-foreground mt-3 text-xs">
          This is taking longer than expected. The workflow may still complete in the background —
          ask the agent to check the status.
        </div>
      )}

      {/* Approve dialog */}
      <AlertDialog
        open={approveOpen}
        onOpenChange={(open) => {
          setApproveOpen(open);
          clearApproveSave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve action?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow will continue from where it paused. Notes are optional and recorded in
              the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="chat-approve-notes">
              Notes (optional){' '}
              <FieldHelp title="Approval notes">
                Optional context for why you approved. Recorded in the audit trail. Leave empty if
                no rationale is needed.
              </FieldHelp>
            </Label>
            <Textarea
              id="chat-approve-notes"
              placeholder="Looks good"
              value={approveNotes}
              onChange={(e) => setApproveNotes(e.target.value)}
              rows={3}
            />
          </div>
          <SaveError failure={approveSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Closes only once the server accepts, so a refusal is read here.
                e.preventDefault();
                void handleApprove();
              }}
              disabled={sending !== null}
            >
              {sending === 'approve' && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject dialog */}
      <AlertDialog
        open={rejectOpen}
        onOpenChange={(open) => {
          setRejectOpen(open);
          clearRejectSave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject action?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow will be cancelled and cannot be resumed. A reason is required for the
              audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="chat-reject-reason">
              Reason{' '}
              <FieldHelp title="Rejection reason">
                Required justification for rejecting. Recorded in the audit trail and surfaced on
                the execution row’s errorMessage so reviewers can understand why the workflow was
                cancelled.
              </FieldHelp>
            </Label>
            <Textarea
              id="chat-reject-reason"
              placeholder="Does not meet compliance"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              maxLength={5000}
              required
            />
          </div>
          <SaveError failure={rejectSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Closes only once the server accepts, so a refusal is read here.
                e.preventDefault();
                void handleReject();
              }}
              disabled={sending !== null || !rejectReason.trim()}
              className="bg-destructive hover:bg-destructive/90"
            >
              {sending === 'reject' && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
