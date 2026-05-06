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
import { API } from '@/lib/api/endpoints';
import type { PendingApproval } from '@/types/orchestration';

const POLL_BASE_MS = 2_000;
const POLL_MAX_MS = 5_000;
const POLL_BUDGET_MS = 5 * 60 * 1_000; // 5 minutes

type Action =
  | 'approve_submit'
  | 'reject_submit'
  | 'submit_ok'
  | 'poll_completed'
  | 'poll_failed'
  | 'poll_expired'
  | 'failure';

type CardState =
  | { kind: 'idle' }
  | { kind: 'submitting'; action: 'approve' | 'reject' }
  | { kind: 'waiting'; action: 'approve' | 'reject' }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string }
  | { kind: 'expired' };

interface ReducerEvent {
  type: Action;
  payload?: { action?: 'approve' | 'reject'; message?: string };
}

function reducer(state: CardState, event: ReducerEvent): CardState {
  switch (event.type) {
    case 'approve_submit':
      return { kind: 'submitting', action: 'approve' };
    case 'reject_submit':
      return { kind: 'submitting', action: 'reject' };
    case 'submit_ok':
      if (state.kind !== 'submitting') return state;
      return { kind: 'waiting', action: state.action };
    case 'poll_completed':
      return { kind: 'completed' };
    case 'poll_failed':
      return { kind: 'failed', message: event.payload?.message ?? 'Workflow failed' };
    case 'poll_expired':
      return { kind: 'expired' };
    case 'failure':
      return { kind: 'failed', message: event.payload?.message ?? 'Action failed' };
    default:
      return state;
  }
}

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

function extractFinalOutput(trace: unknown): unknown {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  // Last completed entry's output is the final result for chained workflows.
  const arr = trace as unknown[];
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i];
    if (
      entry &&
      typeof entry === 'object' &&
      'status' in entry &&
      (entry as { status: unknown }).status === 'completed'
    ) {
      return (entry as { output?: unknown }).output ?? null;
    }
  }
  return null;
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function ApprovalCard({ pendingApproval, onResolved }: ApprovalCardProps) {
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' });
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);

  const pollAbortRef = useRef<AbortController | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);

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
          const res = await fetch(
            API.ADMIN.ORCHESTRATION.executionById(pendingApproval.executionId),
            { credentials: 'include', signal: controller.signal }
          );
          if (!res.ok) throw new Error(`Execution status fetch failed (${res.status})`);
          const json = (await res.json()) as ExecutionResponse;
          const status = json.data?.status;

          if (status === 'completed') {
            const output = extractFinalOutput(json.data?.executionTrace);
            const followup = `Workflow approved. Result: ${safeStringify(output)}`;
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
        setTimeout(() => void tick(), delay);
      };

      void tick();
    },
    [pendingApproval.executionId, onResolved]
  );

  const submit = useCallback(
    async (action: 'approve' | 'reject', body: Record<string, unknown>) => {
      submitAbortRef.current?.abort();
      const controller = new AbortController();
      submitAbortRef.current = controller;

      dispatch({
        type: action === 'approve' ? 'approve_submit' : 'reject_submit',
      });

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
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          dispatch({
            type: 'failure',
            payload: { message: json.error?.message ?? `Request failed (${res.status})` },
          });
          return;
        }
        dispatch({ type: 'submit_ok' });
        startPolling(action);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        dispatch({
          type: 'failure',
          payload: { message: err instanceof Error ? err.message : 'Request failed' },
        });
      }
    },
    [
      pendingApproval.executionId,
      pendingApproval.approveToken,
      pendingApproval.rejectToken,
      startPolling,
    ]
  );

  const handleApprove = useCallback(() => {
    void submit('approve', approveNotes ? { notes: approveNotes } : {});
    setApproveOpen(false);
  }, [submit, approveNotes]);

  const handleReject = useCallback(() => {
    if (!rejectReason.trim()) return;
    void submit('reject', { reason: rejectReason.trim() });
    setRejectOpen(false);
  }, [submit, rejectReason]);

  const expired = state.kind === 'expired';
  const completed = state.kind === 'completed';
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

      {busy && (
        <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>
            {state.kind === 'submitting'
              ? `Submitting ${state.action === 'approve' ? 'approval' : 'rejection'}…`
              : 'Waiting for the workflow to finish…'}
          </span>
        </div>
      )}

      {completed && (
        <div className="text-muted-foreground mt-3 text-xs">Approved — workflow completed.</div>
      )}

      {failed && state.kind === 'failed' && (
        <div className="text-destructive mt-3 text-xs">Failed: {state.message}</div>
      )}

      {expired && (
        <div className="text-muted-foreground mt-3 text-xs">
          Lost connection waiting for approval. Refresh to retry.
        </div>
      )}

      {/* Approve dialog */}
      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
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
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleApprove();
              }}
            >
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject dialog */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
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
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleReject();
              }}
              disabled={!rejectReason.trim()}
              className="bg-destructive hover:bg-destructive/90"
            >
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
