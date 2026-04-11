'use client';

/**
 * InstructionsHistoryPanel (Phase 4 Session 4.2)
 *
 * Collapsible audit-log panel shown under the system-instructions textarea on
 * the Agent edit page (Tab 3). Each PATCH that modifies `systemInstructions`
 * pushes the previous value onto `AiAgent.systemInstructionsHistory`; this
 * component:
 *
 *   - Lazy-fetches `GET /agents/:id/instructions-history` on first expand.
 *   - Renders history rows newest-first with `changedBy`, `changedAt`, and
 *     a 120-char preview.
 *   - Offers a "Diff" dialog (inline LCS-based line diff, no new deps).
 *   - Offers a "Revert" AlertDialog that POSTs
 *     `/agents/:id/instructions-revert` with `{ versionIndex }`.
 *
 * Parent re-renders the whole form after revert succeeds; this panel
 * simply re-fetches its own history on success.
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

interface HistoryEntry {
  instructions: string;
  changedAt: string;
  changedBy: string;
}

interface HistoryResponse {
  agentId: string;
  slug: string;
  current: string;
  history: HistoryEntry[];
}

export interface InstructionsHistoryPanelProps {
  agentId: string;
  /** Called after a successful revert so the parent form can re-fetch. */
  onReverted?: () => void;
}

export function InstructionsHistoryPanel({ agentId, onReverted }: InstructionsHistoryPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [diffOpen, setDiffOpen] = useState<HistoryEntry | null>(null);
  const [revertTarget, setRevertTarget] = useState<{
    entry: HistoryEntry;
    versionIndex: number;
  } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.get<HistoryResponse>(
        API.ADMIN.ORCHESTRATION.agentInstructionsHistory(agentId)
      );
      setData(body);
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not load instructions history.'
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

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
      await apiClient.post(API.ADMIN.ORCHESTRATION.agentInstructionsRevert(agentId), {
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
  }, [revertTarget, agentId, fetchHistory, onReverted]);

  return (
    <div className="border-border rounded-md border">
      <button
        type="button"
        onClick={handleToggle}
        className="hover:bg-muted/40 flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Version history
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
              No previous versions yet. This agent&apos;s instructions haven&apos;t been changed
              since it was created.
            </p>
          )}
          {!loading && !error && data && data.history.length > 0 && (
            <ul className="space-y-2">
              {data.history.map((entry, displayIndex) => {
                // History is returned newest-first. Convert to original
                // versionIndex (oldest = 0) for the revert endpoint.
                const versionIndex = data.history.length - 1 - displayIndex;
                return (
                  <li
                    key={`${entry.changedAt}-${versionIndex}`}
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
                      <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                        {entry.instructions.slice(0, 120)}
                        {entry.instructions.length > 120 ? '…' : ''}
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
                        onClick={() => setRevertTarget({ entry, versionIndex })}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        Revert
                      </Button>
                    </div>
                  </li>
                );
              })}
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
            <DialogTitle>Compare versions</DialogTitle>
            <DialogDescription>
              Red lines were removed; green lines were added going from this historical version to
              the current instructions.
            </DialogDescription>
          </DialogHeader>
          {diffOpen && data && (
            <div className="max-h-[60vh] overflow-auto rounded-md border">
              <DiffView oldText={diffOpen.instructions} newText={data.current} />
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
            <AlertDialogTitle>Revert to this version?</AlertDialogTitle>
            <AlertDialogDescription>
              The current instructions will be pushed onto the history stack before being
              overwritten, so nothing is lost — you can revert again later.
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
 * Minimal LCS-based line diff. Good enough for ~16-row system prompts; we
 * don't want to add a 30 KB diff dep just for this panel.
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
