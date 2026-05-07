'use client';

/**
 * WorkflowDefinitionHistoryPanel
 *
 * Collapsible version-history panel for the workflow builder (edit mode).
 *
 *   - Lazy-fetches `GET /workflows/:id/versions` on first expand.
 *   - Renders versions newest-first with step count preview.
 *   - "Diff" dialog compares the historical snapshot to the currently-published one.
 *   - "Rollback" AlertDialog posts to `/workflows/:id/rollback` — creates a NEW
 *     version copied from the target so the audit chain stays monotonic.
 */

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, GitCompare, RotateCcw } from 'lucide-react';

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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';

interface VersionRow {
  id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changeSummary: string | null;
  createdAt: string;
  createdBy: string;
}

interface VersionsListResponse {
  versions: VersionRow[];
  publishedVersionId: string | null;
  nextCursor: string | null;
}

interface DerivedHistory {
  publishedSnapshot: Record<string, unknown> | null;
  entries: VersionRow[];
}

export interface WorkflowDefinitionHistoryPanelProps {
  workflowId: string;
  /** Called after a successful revert so the parent can re-fetch. */
  onReverted?: () => void;
}

function definitionPreview(def: Record<string, unknown>): string {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const entry = typeof def.entryStepId === 'string' ? def.entryStepId : '?';
  return `${steps.length} step${steps.length === 1 ? '' : 's'}, entry: ${entry}`;
}

export function WorkflowDefinitionHistoryPanel({
  workflowId,
  onReverted,
}: WorkflowDefinitionHistoryPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DerivedHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [diffOpen, setDiffOpen] = useState<VersionRow | null>(null);
  const [revertTarget, setRevertTarget] = useState<VersionRow | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.get<VersionsListResponse>(
        API.ADMIN.ORCHESTRATION.workflowVersions(workflowId)
      );
      const publishedSnapshot =
        body.versions.find((v) => v.id === body.publishedVersionId)?.snapshot ?? null;
      // Show non-current versions, newest first.
      const entries = body.versions.filter((v) => v.id !== body.publishedVersionId);
      setData({ publishedSnapshot, entries });
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not load definition history.');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && !data && !loading) void fetchHistory();
  }, [expanded, data, loading, fetchHistory]);

  const handleRevert = useCallback(async () => {
    if (!revertTarget) return;
    setReverting(true);
    setRevertError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.workflowRollback(workflowId), {
        body: { targetVersionId: revertTarget.id },
      });
      setRevertTarget(null);
      await fetchHistory();
      onReverted?.();
    } catch (err) {
      setRevertError(
        err instanceof APIClientError ? err.message : 'Rollback failed. Try again in a moment.'
      );
    } finally {
      setReverting(false);
    }
  }, [revertTarget, workflowId, fetchHistory, onReverted]);

  return (
    <div className="border-border rounded-md border">
      <button
        type="button"
        onClick={handleToggle}
        className="hover:bg-muted/40 flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Definition history
        <FieldHelp title="Definition history">
          Every save creates a versioned snapshot. You can compare any two versions with the Diff
          button, or revert to a previous version — reverts are also tracked, so nothing is lost.
        </FieldHelp>
        {data && (
          <span className="text-muted-foreground ml-1 text-xs">
            ({data.entries.length} {data.entries.length === 1 ? 'version' : 'versions'})
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t px-3 py-3">
          {loading && <p className="text-muted-foreground text-sm">Loading history…</p>}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {!loading && !error && data && data.entries.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No previous versions yet. This workflow&apos;s definition hasn&apos;t been changed
              since it was created.
            </p>
          )}
          {!loading && !error && data && data.entries.length > 0 && (
            <ul className="space-y-2">
              {data.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="bg-muted/30 flex items-start justify-between gap-3 rounded-md p-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs">
                      <span className="font-medium">v{entry.version}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                      <span className="text-muted-foreground"> · {entry.createdBy}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      {definitionPreview(entry.snapshot)}
                    </p>
                    {entry.changeSummary && (
                      <p className="text-muted-foreground mt-1 text-xs italic">
                        {entry.changeSummary}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDiffOpen(entry)}
                    >
                      <GitCompare className="mr-1 h-3 w-3" />
                      Diff
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevertTarget(entry)}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      Rollback
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Diff dialog */}
      <Dialog
        open={!!diffOpen}
        onOpenChange={(open) => {
          if (!open) setDiffOpen(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Compare definitions</DialogTitle>
            <DialogDescription>
              Red lines were removed; green lines were added going from this historical version to
              the currently published definition.
            </DialogDescription>
          </DialogHeader>
          {diffOpen && data && (
            <div className="max-h-[60vh] overflow-auto rounded-md border">
              <DiffView
                oldText={JSON.stringify(diffOpen.snapshot, null, 2)}
                newText={JSON.stringify(data.publishedSnapshot ?? {}, null, 2)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rollback confirm */}
      <AlertDialog
        open={!!revertTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRevertTarget(null);
            setRevertError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to this version?</AlertDialogTitle>
            <AlertDialogDescription>
              A new published version will be created with this snapshot. The audit chain is
              monotonic — no historical version is mutated, and rolling forward is just another
              rollback.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revertError && <p className="text-destructive text-sm">{revertError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
            {/*
              `event.preventDefault()` keeps the dialog open across the async
              POST so a failure surfaces inline via `revertError` rather than
              the dialog auto-closing per Radix's default action behaviour.
              `handleRevert` itself closes the dialog on success by clearing
              `revertTarget`.
            */}
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRevert();
              }}
              disabled={reverting}
            >
              {reverting ? 'Rolling back…' : 'Rollback'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Minimal LCS-based line diff — same algorithm as InstructionsHistoryPanel.
 */
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lcs = buildLcs(oldLines, newLines);
  const rows = buildDiffRows(oldLines, newLines, lcs);

  return (
    <pre className="text-xs leading-relaxed">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            'px-3 py-0.5',
            row.type === 'add' && 'bg-green-500/10 text-green-800 dark:text-green-200',
            row.type === 'del' && 'bg-red-500/10 text-red-800 dark:text-red-200'
          )}
        >
          <span className="text-muted-foreground mr-2">
            {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
          </span>
          {row.text || '\u00A0'}
        </div>
      ))}
    </pre>
  );
}

type DiffRow = { type: 'same' | 'add' | 'del'; text: string };

function buildLcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function buildDiffRows(a: string[], b: string[], dp: number[][]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ type: 'del', text: a[i++] });
  while (j < b.length) rows.push({ type: 'add', text: b[j++] });
  return rows;
}
