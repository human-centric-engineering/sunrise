'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';

import { TextDiffViewer } from '@/components/admin/orchestration/knowledge/text-diff-viewer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SaveError } from '@/components/forms/form-error';
import { apiClient, apiErrorFromResponse } from '@/lib/api/client';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

interface PendingChangeRecord {
  id: string;
  source: 'rewrite_with_llm' | 'rewrite_section_with_llm';
  beforeContent: string;
  afterContent: string;
  sectionMarker: string | null;
  instructions: string;
}

interface PendingChangeModalProps {
  documentId: string;
  /** The pending-change id surfaced via capability_result. */
  changeId: string | null;
  onClose: () => void;
  /** Fired after Accept or Reject so the parent can re-fetch the doc. */
  onResolved: () => void;
}

// Renders a side-by-side diff for a pending LLM rewrite + Accept / Reject
// buttons. Opens when the chat surface intercepts a capability_result for
// `rewrite_with_llm` or `rewrite_section_with_llm` and the response carries
// a `pendingChangeId`.
//
// Loads the change record on open from the per-change GET. Fetching it there
// rather than off the documents/[id] route keeps the proposal's full before +
// after copy of the document out of the doc payload, which the cleanup view
// re-fetches after every chat turn and capability result.
export function PendingChangeModal({
  documentId,
  changeId,
  onClose,
  onResolved,
}: PendingChangeModalProps) {
  const [record, setRecord] = useState<PendingChangeRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<'accept' | 'reject' | null>(null);
  // The load error, shown in place of the diff. A failed Accept or Reject
  // shows above the buttons instead, and the diff stays.
  const [error, setError] = useState<string | null>(null);
  const acceptFailure = useSaveFailure({
    fallback: 'Could not accept the change. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const rejectFailure = useSaveFailure({
    fallback: 'Could not reject the change. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const { clear: clearAcceptFailure, report: reportAcceptFailure } = acceptFailure;
  const { clear: clearRejectFailure, report: reportRejectFailure } = rejectFailure;

  const open = changeId !== null;

  useEffect(() => {
    clearAcceptFailure();
    clearRejectFailure();
    if (!open || !changeId) {
      setRecord(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // The capability_result that triggers this modal carries the pending
        // change content directly in the chat trace, but the modal is rendered
        // outside that scope — fetch the row by id.
        const body = await apiClient.get<{ change: PendingChangeRecord }>(
          `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}`
        );
        if (cancelled) return;
        if (!body.change) throw new Error('Pending change not found');
        setRecord(body.change);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load pending change');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, changeId, documentId, clearAcceptFailure, clearRejectFailure]);

  const accept = useCallback(async () => {
    if (!changeId) return;
    setActing('accept');
    clearAcceptFailure();
    clearRejectFailure();
    try {
      const res = await fetch(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}/accept`,
        { method: 'POST' }
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      onResolved();
      onClose();
    } catch (err) {
      reportAcceptFailure(err);
    } finally {
      setActing(null);
    }
  }, [
    changeId,
    documentId,
    onResolved,
    onClose,
    clearAcceptFailure,
    clearRejectFailure,
    reportAcceptFailure,
  ]);

  const reject = useCallback(async () => {
    if (!changeId) return;
    setActing('reject');
    clearAcceptFailure();
    clearRejectFailure();
    try {
      const res = await fetch(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}/reject`,
        { method: 'POST' }
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      onResolved();
      onClose();
    } catch (err) {
      reportRejectFailure(err);
    } finally {
      setActing(null);
    }
  }, [
    changeId,
    documentId,
    onResolved,
    onClose,
    clearAcceptFailure,
    clearRejectFailure,
    reportRejectFailure,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Committed while Accept or Reject runs: Escape waits for it.
        if (!next && acting === null) onClose();
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Review LLM rewrite
          </DialogTitle>
          <DialogDescription>
            The agent proposed a change. Accept to apply it (writes a revision); Reject to discard
            it (doc unchanged, no revision).
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center p-8 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : record ? (
          <>
            <div className="text-muted-foreground space-y-1 text-xs">
              <p>
                <strong className="text-foreground">Source:</strong>{' '}
                {record.source === 'rewrite_with_llm'
                  ? 'Whole-document rewrite'
                  : `Section rewrite: ${record.sectionMarker ?? '?'}`}
              </p>
              <p>
                <strong className="text-foreground">Instructions:</strong> {record.instructions}
              </p>
            </div>
            <TextDiffViewer before={record.beforeContent} after={record.afterContent} />
          </>
        ) : null}

        <SaveError failure={acceptFailure.failure ?? rejectFailure.failure} />

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => void reject()}
            disabled={acting !== null || !record}
          >
            {acting === 'reject' ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <X className="mr-1 h-3 w-3" />
            )}
            Reject
          </Button>
          <Button onClick={() => void accept()} disabled={acting !== null || !record}>
            {acting === 'accept' ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            Accept
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
