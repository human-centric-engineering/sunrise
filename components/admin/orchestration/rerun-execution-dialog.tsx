'use client';

/**
 * RerunExecutionDialog — confirmation surface for re-running an
 * existing execution with the same inputData.
 *
 * On open the dialog fetches the workflow's version history and the
 * current cost estimate in parallel. The version Select is filtered
 * to versions whose number is greater than or equal to the original
 * execution's version (so the operator can pick the current published,
 * any intermediate version published since the original ran, or the
 * original version itself). Default selection: the workflow's current
 * published version.
 *
 * Confirmation posts to `executionRerun(originalId)` and consumes the
 * resulting SSE stream just long enough to capture the new
 * `executionId` from `workflow_started`, then navigates to the new
 * execution's detail page. The fetch is intentionally not aborted on
 * unmount — see `audit-models-dialog.tsx` for the same pattern and
 * the reason.
 *
 * Side-effect warning: every capability dispatch and notification in
 * the workflow will re-fire. The operator confirms this explicitly.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import type { WorkflowCostEstimate } from '@/lib/orchestration/cost-estimation/workflow-cost';

export interface RerunExecutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The execution being re-run. */
  execution: {
    id: string;
    workflowId: string;
    /** Pinned version id of the original run. May be null on legacy rows. */
    versionId: string | null;
  };
}

interface VersionRow {
  id: string;
  version: number;
  changeSummary: string | null;
  createdAt: string;
}

interface VersionsResponse {
  versions: VersionRow[];
  publishedVersionId: string | null;
  nextCursor: string | null;
}

function formatUsd(amount: number): string {
  if (amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

export function RerunExecutionDialog({ open, onOpenChange, execution }: RerunExecutionDialogProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<WorkflowCostEstimate | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load versions + cost estimate in parallel on open. The cost
  // estimate is the workflow's current-published estimate — close
  // enough for a "rerun this thing" decision; computing per-version
  // estimates is out of scope here.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setEstimate(null);
    setVersions(null);
    let cancelled = false;
    void (async () => {
      try {
        const [v, e] = await Promise.allSettled([
          apiClient.get<VersionsResponse>(
            API.ADMIN.ORCHESTRATION.workflowVersions(execution.workflowId)
          ),
          apiClient.get<WorkflowCostEstimate>(
            API.ADMIN.ORCHESTRATION.workflowCostEstimate(execution.workflowId)
          ),
        ]);
        if (cancelled) return;
        if (v.status !== 'fulfilled') {
          // Versions are critical — without the list we can't render a chooser.
          throw v.reason instanceof Error ? v.reason : new Error('Failed to load versions');
        }
        setVersions(v.value.versions);
        setPublishedVersionId(v.value.publishedVersionId);
        // Default selection: current published wins. Falls back to the
        // original execution's version when the workflow has no
        // published version (legacy state) or — defensively — to the
        // newest available row.
        const initial =
          v.value.publishedVersionId ?? execution.versionId ?? v.value.versions[0]?.id ?? null;
        setSelectedVersionId(initial);
        // Cost estimate is decorative — proceed even if it fails.
        if (e.status === 'fulfilled') setEstimate(e.value);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof APIClientError
            ? err.message
            : 'Failed to load workflow versions for re-run.'
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, execution.workflowId, execution.versionId]);

  // Find the original execution's version number so we can filter the
  // Select to "versions added since the original run, plus the
  // original itself". Legacy executions (versionId === null) skip the
  // filter and show the full list — they have no anchor.
  const originalVersionNumber = useMemo(() => {
    if (!versions || !execution.versionId) return null;
    return versions.find((v) => v.id === execution.versionId)?.version ?? null;
  }, [versions, execution.versionId]);

  const eligibleVersions = useMemo(() => {
    if (!versions) return [];
    if (originalVersionNumber === null) return versions; // legacy fallback
    return versions.filter((v) => v.version >= originalVersionNumber);
  }, [versions, originalVersionNumber]);

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      // Re-use the audit-models-dialog pattern: POST to the SSE
      // endpoint via raw `fetch` (apiClient would buffer the body),
      // read frame-by-frame until `workflow_started` arrives, then
      // detach the stream so the engine doesn't get aborted when
      // we close the dialog.
      const res = await fetch(API.ADMIN.ORCHESTRATION.executionRerun(execution.id), {
        method: 'POST',
        credentials: 'include',
        // No AbortController — see audit-models-dialog comment.
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(selectedVersionId ? { versionId: selectedVersionId } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        // Try to surface the server's error envelope when available.
        let serverMessage = `Re-run failed with HTTP ${res.status}`;
        try {
          const json = (await res.json()) as { error?: { message?: string } };
          if (json.error?.message) serverMessage = json.error.message;
        } catch {
          /* not JSON; keep the HTTP message */
        }
        throw new Error(serverMessage);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let newExecutionId: string | null = null;
      while (newExecutionId === null) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseBlock(block);
          if (parsed?.type === 'workflow_started' && typeof parsed.data.executionId === 'string') {
            newExecutionId = parsed.data.executionId;
            break;
          }
        }
      }
      // Detached drain so the engine isn't aborted on close.
      void (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* engine likely finished; stream tore down */
        }
      })();
      if (!newExecutionId) {
        throw new Error('Stream closed before workflow_started arrived. Check the audit log.');
      }
      // Navigate before closing the dialog so the page transition
      // covers the close animation.
      router.push(`/admin/orchestration/executions/${newExecutionId}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-run failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const showChooser = eligibleVersions.length > 1;
  const onlyOriginalAvailable =
    !loading && eligibleVersions.length === 1 && execution.versionId !== null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Re-run this execution?</AlertDialogTitle>
          <AlertDialogDescription>
            Creates a new execution with the same input data as the original. Every step runs again
            — including capability dispatches and notifications. There is no &ldquo;dry run&rdquo;
            mode.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2 text-sm">
          {loading && (
            <div className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading workflow versions…
            </div>
          )}

          {!loading && showChooser && (
            <div className="space-y-1.5">
              <Label htmlFor="rerun-version" className="text-xs">
                Run against version
              </Label>
              <Select value={selectedVersionId ?? undefined} onValueChange={setSelectedVersionId}>
                <SelectTrigger id="rerun-version" data-testid="rerun-version-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eligibleVersions.map((v) => {
                    const isPublished = v.id === publishedVersionId;
                    const isOriginal = v.id === execution.versionId;
                    const labelParts = [`v${v.version}`];
                    if (v.changeSummary) labelParts.push(`— ${v.changeSummary}`);
                    const badges = [
                      isPublished ? 'current published' : null,
                      isOriginal ? 'original' : null,
                    ]
                      .filter(Boolean)
                      .join(', ');
                    return (
                      <SelectItem key={v.id} value={v.id} data-testid={`rerun-version-${v.id}`}>
                        {labelParts.join(' ')}
                        {badges ? ` · ${badges}` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px]">
                {publishedVersionId === execution.versionId
                  ? 'No new versions have been published since the original run.'
                  : 'Versions newer than the original are listed first.'}
              </p>
            </div>
          )}

          {onlyOriginalAvailable && (
            // The original is the only eligible version — no chooser needed,
            // but we still tell the operator what we're going to do.
            <p className="text-muted-foreground text-xs" data-testid="rerun-same-version-notice">
              Re-running against the same version this execution used (no newer versions have been
              published).
            </p>
          )}

          {estimate && (
            <p className="text-muted-foreground text-xs" data-testid="rerun-cost-estimate">
              Estimated cost: {formatUsd(estimate.lowUsd)}–{formatUsd(estimate.highUsd)} per run
              (current published version).
            </p>
          )}

          {error && (
            <p className="text-destructive text-xs" data-testid="rerun-error">
              {error}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading || submitting || (!selectedVersionId && !!execution.versionId)}
            onClick={(e) => {
              // Prevent default close-on-click — we want to keep the
              // dialog open while the SSE stream gives us the new id.
              e.preventDefault();
              void handleConfirm();
            }}
            data-testid="rerun-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              'Re-run'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
