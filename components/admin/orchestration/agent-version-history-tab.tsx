'use client';

/**
 * AgentVersionHistoryTab — full config version history.
 *
 * Edit-mode tab showing the AiAgentVersion timeline. Each row displays
 * version number, change summary, creator, and date. Expand to see the
 * field-level diff for the save that created this row, and restore to
 * roll back the agent to that point.
 *
 * Diff semantic: snapshots are POINT-IN-TIME — `versions[i].snapshot`
 * holds the agent config AS OF that version (the post-save state — see
 * the PATCH route's snapshot writer). Versions are listed newest-first,
 * so for the row at index i:
 *
 *   • "After"  = `versions[i].snapshot` — this version's own state.
 *   • "Before" = `versions[i+1].snapshot` — the next-OLDER version, i.e.
 *     the state this save changed FROM. The oldest row (the "Initial
 *     configuration" v1) has no older neighbour, so its "Before" is
 *     null and the diff shows the full initial config.
 *
 * The newest row equals the live agent by construction (every versioned
 * change writes a version), so there's no live-agent special case and no
 * extra fetch. Restore is offered on every row except the newest (idx 0)
 * — restoring the newest is a no-op since it already equals live.
 *
 * Lazy-fetches the version list on mount. Per-version snapshots are pulled
 * on demand when a row is expanded and cached, so the same blob serves as
 * "After" for row i and "Before" for row i-1 (its newer neighbour).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Clock, Loader2, RotateCcw } from 'lucide-react';

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
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import {
  diffAgentSnapshots,
  formatSnapshotValue,
  type FieldChange,
} from '@/lib/orchestration/agent-version-diff';

interface VersionEntry {
  id: string;
  version: number;
  changeSummary: string | null;
  createdBy: string;
  createdAt: string;
  // Populated by the versions GET route. Optional so legacy rows (if
  // any pre-creator-join calls are cached) degrade gracefully.
  creator?: { id: string; name: string; email: string } | null;
}

interface VersionDetail {
  id: string;
  version: number;
  snapshot: Record<string, unknown>;
}

/**
 * Per-row fetch state. Tracks an in-flight load and the last error
 * (if any) separately from the cached snapshots, so a failed load on
 * row A doesn't surface as an error on row B.
 */
interface ExpansionState {
  loading: boolean;
  error: string | null;
}

export interface AgentVersionHistoryTabProps {
  agentId: string;
  /** Called after a successful restore so the parent form can refresh. */
  onRestored?: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Compact renderer for a single before/after value cell. Long
 * strings (most commonly `systemInstructions`) are dropped into a
 * scrollable `<pre>` so the row doesn't blow up vertically; short
 * values render inline.
 */
function ValueCell({ value }: { value: unknown }) {
  const formatted = formatSnapshotValue(value);
  const isLong = typeof value === 'string' && value.length > 120;

  if (isLong) {
    return (
      <pre className="bg-muted/40 max-h-40 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">
        {formatted}
      </pre>
    );
  }
  return (
    <span className={cn('break-words', formatted === '—' && 'text-muted-foreground')}>
      {formatted}
    </span>
  );
}

function DiffTable({ changes }: { changes: FieldChange[] }) {
  if (changes.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No field-level differences detected for this save. (The change summary may be from a field
        that isn&apos;t surfaced in the snapshot.)
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Field</th>
            <th className="px-2 py-1.5 text-left font-medium">Before</th>
            <th className="px-2 py-1.5 text-left font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.field} className="border-t align-top">
              <td className="px-2 py-1.5 font-medium whitespace-nowrap">{c.label}</td>
              <td className="px-2 py-1.5">
                <ValueCell value={c.before} />
              </td>
              <td className="px-2 py-1.5">
                <ValueCell value={c.after} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentVersionHistoryTab({ agentId, onRestored }: AgentVersionHistoryTabProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Expansion + snapshot cache. Keyed by version id so a successful
  // load is shared between consecutive rows: a row's "after"
  // snapshot (the next-newer row's pre-state) doubles as that
  // newer row's "before" snapshot.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [snapshots, setSnapshots] = useState<Record<string, Record<string, unknown>>>({});
  const [rowState, setRowState] = useState<Record<string, ExpansionState>>({});

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<VersionEntry[]>(
        `${API.ADMIN.ORCHESTRATION.agentVersions(agentId)}?limit=50`
      );
      setVersions(data);
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not load version history. Try again.'
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchVersions();
  }, [fetchVersions]);

  const handleRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await apiClient.post(
        API.ADMIN.ORCHESTRATION.agentVersionRestore(agentId, restoreTarget.id),
        {}
      );
      setRestoreTarget(null);
      // The restore wrote a new version (the post-restore state). Reloading the
      // list surfaces it as the new newest row, which equals live by construction.
      void fetchVersions();
      onRestored?.();
    } catch (err) {
      setRestoreError(
        err instanceof APIClientError ? err.message : 'Restore failed. Try again in a moment.'
      );
    } finally {
      setRestoring(false);
    }
  }, [restoreTarget, agentId, fetchVersions, onRestored]);

  /**
   * Fetch a single version's snapshot (idempotent — short-circuits
   * if already cached or already loading).
   */
  const ensureSnapshot = useCallback(
    async (versionId: string) => {
      if (snapshots[versionId] || rowState[versionId]?.loading) return;
      setRowState((s) => ({ ...s, [versionId]: { loading: true, error: null } }));
      try {
        const detail = await apiClient.get<VersionDetail>(
          API.ADMIN.ORCHESTRATION.agentVersionById(agentId, versionId)
        );
        setSnapshots((map) => ({ ...map, [versionId]: detail.snapshot ?? {} }));
        setRowState((s) => ({ ...s, [versionId]: { loading: false, error: null } }));
      } catch (err) {
        const message =
          err instanceof APIClientError ? err.message : 'Could not load version snapshot.';
        setRowState((s) => ({ ...s, [versionId]: { loading: false, error: message } }));
      }
    },
    [agentId, snapshots, rowState]
  );

  const toggleExpand = useCallback(
    (entry: VersionEntry, olderNeighbour: VersionEntry | null) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(entry.id)) {
          next.delete(entry.id);
        } else {
          next.add(entry.id);
          // Kick off snapshot loads for this row (its own snapshot is the
          // "After" — the state as of this version) and the older neighbour
          // (whose snapshot is the "Before", the state this save changed from).
          // The oldest row has no older neighbour; its "Before" is null.
          void ensureSnapshot(entry.id);
          if (olderNeighbour) void ensureSnapshot(olderNeighbour.id);
        }
        return next;
      });
    },
    [ensureSnapshot]
  );

  // Compute the diff for each expanded row.
  //
  // Snapshots are POINT-IN-TIME state, so for the row at index i (newest-first):
  //   • After  = versions[i].snapshot   (this version's own state).
  //   • Before = versions[i+1].snapshot (the next-older version), or null for
  //              the oldest row — which then shows the full initial config.
  const diffByVersion = useMemo(() => {
    const out: Record<string, FieldChange[]> = {};
    for (let i = 0; i < versions.length; i++) {
      const entry = versions[i];
      if (!expanded.has(entry.id)) continue;
      const afterSnap = snapshots[entry.id];
      if (!afterSnap) continue;

      const olderEntry = i < versions.length - 1 ? versions[i + 1] : null;
      let beforeSnap: Record<string, unknown> | null;
      if (olderEntry === null) {
        // Oldest row (Initial configuration) — no prior state to diff against.
        beforeSnap = null;
      } else {
        const olderSnap = snapshots[olderEntry.id];
        if (!olderSnap) continue;
        beforeSnap = olderSnap;
      }

      out[entry.id] = diffAgentSnapshots(afterSnap, beforeSnap);
    }
    return out;
  }, [versions, expanded, snapshots]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        <span className="text-muted-foreground ml-2 text-sm">Loading version history…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
        {error}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          Version history{' '}
          <FieldHelp title="Agent version history">
            When you save changes to configuration fields (model, instructions, temperature, guard
            modes, etc.), a snapshot of the full configuration is stored. Changes to name or
            description alone do not create a version. Click a row to see the field-level diff
            against the previous version. Restoring creates a new version entry so the action is
            auditable.
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {versions.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span>No version history yet. Changes will appear here after the first save.</span>
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {versions.map((v, idx) => {
              // Older neighbour (the next-older version, whose snapshot is this
              // row's "Before"). The oldest row has none — it shows the full
              // initial config.
              const olderNeighbour = idx < versions.length - 1 ? versions[idx + 1] : null;
              const isOpen = expanded.has(v.id);
              const rowError = rowState[v.id]?.error ?? null;
              const rowLoading = rowState[v.id]?.loading ?? false;
              const neighbourLoading = olderNeighbour
                ? (rowState[olderNeighbour.id]?.loading ?? false)
                : false;
              const diff = diffByVersion[v.id];

              return (
                <li key={v.id} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <button
                      type="button"
                      onClick={() => toggleExpand(v, olderNeighbour)}
                      aria-expanded={isOpen}
                      aria-controls={`version-diff-${v.id}`}
                      className="group hover:bg-muted/40 -mx-2 flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-0.5 text-left"
                    >
                      <ChevronDown
                        className={cn(
                          'text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform',
                          isOpen ? 'rotate-0' : '-rotate-90'
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px] tabular-nums"
                          >
                            v{v.version}
                          </Badge>
                          <span className="font-medium">
                            {v.changeSummary ?? 'Configuration updated'}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {formatDate(v.createdAt)}
                          {v.creator ? (
                            <>
                              {' · '}
                              <span title={v.creator.email}>{v.creator.name}</span>
                            </>
                          ) : null}
                        </p>
                      </div>
                    </button>
                    {idx > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setRestoreTarget(v)}
                        title={`Restore agent to version ${v.version}`}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Restore
                      </Button>
                    )}
                  </div>

                  {isOpen && (
                    <div id={`version-diff-${v.id}`} className="mt-3 ml-5.5 space-y-2">
                      {rowError && (
                        <p className="border-destructive/50 bg-destructive/5 text-destructive rounded border px-2 py-1 text-xs">
                          {rowError}
                        </p>
                      )}
                      {(rowLoading || neighbourLoading) && !diff && (
                        <div className="text-muted-foreground flex items-center gap-2 text-xs">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          <span>Loading snapshot…</span>
                        </div>
                      )}
                      {diff && <DiffTable changes={diff} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={() => {
          setRestoreTarget(null);
          setRestoreError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore to version {restoreTarget?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert the agent&apos;s configuration (model, instructions, settings) to the
              state captured in version {restoreTarget?.version}. A new version entry will be
              created to record this action. Conversations and cost history are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restoreError && (
            <p className="border-destructive/50 bg-destructive/5 text-destructive rounded border px-2 py-1.5 text-sm">
              {restoreError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // Prevent Radix's default close-on-click: a failed restore must
              // keep the dialog open so `restoreError` (rendered above) is
              // visible. handleRestore closes the dialog itself on success.
              onClick={(e) => {
                e.preventDefault();
                void handleRestore();
              }}
              disabled={restoring}
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
