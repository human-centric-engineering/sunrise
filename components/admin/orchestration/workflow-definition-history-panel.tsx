'use client';

/**
 * WorkflowDefinitionHistoryPanel
 *
 * Collapsible audit-log panel for the workflow builder (edit mode).
 * Adapted from `InstructionsHistoryPanel` — same UX, different data shape.
 *
 *   - Lazy-fetches `GET /workflows/:id/definition-history` on first expand.
 *   - Renders history rows newest-first with step count preview.
 *   - "Diff" dialog shows JSON pretty-print diff.
 *   - "Revert" AlertDialog posts to `/workflows/:id/definition-revert`.
 */

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, GitCompare, RotateCcw } from 'lucide-react';

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

interface DefinitionHistoryEntry {
  definition: Record<string, unknown>;
  changedAt: string;
  changedBy: string;
  versionIndex: number;
}

interface DefinitionHistoryResponse {
  workflowId: string;
  slug: string;
  current: Record<string, unknown>;
  history: DefinitionHistoryEntry[];
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
  const [data, setData] = useState<DefinitionHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [diffOpen, setDiffOpen] = useState<DefinitionHistoryEntry | null>(null);
  const [revertTarget, setRevertTarget] = useState<DefinitionHistoryEntry | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.get<DefinitionHistoryResponse>(
        API.ADMIN.ORCHESTRATION.workflowDefinitionHistory(workflowId)
      );
      setData(body);
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
      await apiClient.post(API.ADMIN.ORCHESTRATION.workflowDefinitionRevert(workflowId), {
        body: { versionIndex: revertTarget.versionIndex },
      });
      setRevertTarget(null);
      await fetchHistory();
      onReverted?.();
    } catch (err) {
      setRevertError(
        err instanceof APIClientError ? err.message : 'Revert failed. Try again in a moment.'
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
        {data && (
          <span className="text-muted-foreground ml-1 text-xs">
            ({data.history.length} {data.history.length === 1 ? 'version' : 'versions'})
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t px-3 py-3">
          {loading && <p className="text-muted-foreground text-sm">Loading history…</p>}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {!loading && !error && data && data.history.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No previous versions yet. This workflow&apos;s definition hasn&apos;t been changed
              since it was created.
            </p>
          )}
          {!loading && !error && data && data.history.length > 0 && (
            <ul className="space-y-2">
              {data.history.map((entry) => (
                <li
                  key={`${entry.changedAt}-${entry.versionIndex}`}
                  className="bg-muted/30 flex items-start justify-between gap-3 rounded-md p-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs">
                      <span className="font-medium">{entry.changedBy}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        {new Date(entry.changedAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      {definitionPreview(entry.definition)}
                    </p>
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
                      Revert
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
              the current definition.
            </DialogDescription>
          </DialogHeader>
          {diffOpen && data && (
            <div className="max-h-[60vh] overflow-auto rounded-md border">
              <DiffView
                oldText={JSON.stringify(diffOpen.definition, null, 2)}
                newText={JSON.stringify(data.current, null, 2)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revert confirm */}
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
            <AlertDialogTitle>Revert to this definition?</AlertDialogTitle>
            <AlertDialogDescription>
              The current definition will be pushed onto the history stack before being overwritten,
              so nothing is lost — you can revert again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revertError && <p className="text-destructive text-sm">{revertError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRevert()} disabled={reverting}>
              {reverting ? 'Reverting…' : 'Revert'}
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
