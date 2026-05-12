'use client';

/**
 * AgentVersionHistoryTab — full config version history.
 *
 * Edit-mode tab showing the AiAgentVersion timeline. Each row displays
 * version number, change summary, creator, and date. Expand to see the
 * field-level diff for the save that created this row, and restore to
 * roll back the agent to that point.
 *
 * Diff semantic: snapshots capture the PRE-update state (the state
 * that was about to be overwritten — see the PATCH route's snapshot
 * writer). So:
 *
 *   • A row's "Before" = `versions[i].snapshot` — the state that was
 *     replaced by the save this row represents.
 *   • A row's "After" = `versions[i-1].snapshot` if a newer version
 *     row exists (the next save captured this state as its own
 *     "before"), or the live agent state for the newest row (whose
 *     save's post-update state lives on the agent row itself, not in
 *     any version snapshot).
 *
 * Lazy-fetches versions on mount, plus the live agent (used as the
 * newest row's "After"). Per-version snapshots are pulled on demand
 * when a row is expanded and cached so the same blob serves as
 * "Before" for row i and "After" for row i+1.
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
  extractSnapshotFromAgent,
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

  // Live agent state — used as the "After" for the newest version
  // row, since the save that created v[N] left its result on the
  // agent row itself rather than in any version snapshot.
  const [liveSnapshot, setLiveSnapshot] = useState<Record<string, unknown> | null>(null);
  const [liveSnapshotError, setLiveSnapshotError] = useState<string | null>(null);

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

  const fetchLiveSnapshot = useCallback(async () => {
    setLiveSnapshotError(null);
    try {
      const agent = await apiClient.get<Record<string, unknown>>(
        API.ADMIN.ORCHESTRATION.agentById(agentId)
      );
      setLiveSnapshot(extractSnapshotFromAgent(agent));
    } catch (err) {
      setLiveSnapshotError(
        err instanceof APIClientError
          ? err.message
          : 'Could not load current agent state for the latest diff.'
      );
    }
  }, [agentId]);

  useEffect(() => {
    void fetchVersions();
    void fetchLiveSnapshot();
  }, [fetchVersions, fetchLiveSnapshot]);

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
      void fetchVersions();
      // The agent row was just rewritten by the restore — reload its
      // live state so the newest row's "After" reflects reality.
      void fetchLiveSnapshot();
      onRestored?.();
    } catch (err) {
      setRestoreError(
        err instanceof APIClientError ? err.message : 'Restore failed. Try again in a moment.'
      );
    } finally {
      setRestoring(false);
    }
  }, [restoreTarget, agentId, fetchVersions, fetchLiveSnapshot, onRestored]);

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
    (entry: VersionEntry, newerNeighbour: VersionEntry | null) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(entry.id)) {
          next.delete(entry.id);
        } else {
          next.add(entry.id);
          // Kick off snapshot loads for this row (its own snapshot is
          // the "Before") and the newer neighbour (whose snapshot is
          // the "After" for this row, since the newer save captured
          // this row's post-state as its own pre-state). If there is
          // no newer neighbour, the live agent state — already
          // fetched on mount — provides the "After".
          void ensureSnapshot(entry.id);
          if (newerNeighbour) void ensureSnapshot(newerNeighbour.id);
        }
        return next;
      });
    },
    [ensureSnapshot]
  );

  // Compute the diff for each expanded row.
  //
  // Snapshots are PRE-update state, so for the row at index i:
  //   • Before = versions[i].snapshot (the state that save i replaced).
  //   • After  = versions[i-1].snapshot if a newer row exists (the
  //               next save captured this row's post-state as its own
  //               pre-state), else the live agent state for index 0.
  const diffByVersion = useMemo(() => {
    const out: Record<string, FieldChange[]> = {};
    for (let i = 0; i < versions.length; i++) {
      const entry = versions[i];
      if (!expanded.has(entry.id)) continue;
      const beforeSnap = snapshots[entry.id];
      if (!beforeSnap) continue;

      let afterSnap: Record<string, unknown> | null;
      if (i === 0) {
        // Newest row — "After" lives on the agent itself.
        afterSnap = liveSnapshot;
        if (afterSnap === null) continue;
      } else {
        const newerEntry = versions[i - 1];
        const newerSnap = snapshots[newerEntry.id];
        if (!newerSnap) continue;
        afterSnap = newerSnap;
      }

      out[entry.id] = diffAgentSnapshots(afterSnap, beforeSnap);
    }
    return out;
  }, [versions, expanded, snapshots, liveSnapshot]);

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
              // Newer neighbour (the next save that captured this
              // row's post-state). For the newest row (idx 0) this
              // is null — the "After" comes from the live agent.
              const newerNeighbour = idx > 0 ? versions[idx - 1] : null;
              const isOpen = expanded.has(v.id);
              const rowError = rowState[v.id]?.error ?? null;
              const rowLoading = rowState[v.id]?.loading ?? false;
              const neighbourLoading = newerNeighbour
                ? (rowState[newerNeighbour.id]?.loading ?? false)
                : false;
              const isNewest = idx === 0;
              const diff = diffByVersion[v.id];

              return (
                <li key={v.id} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <button
                      type="button"
                      onClick={() => toggleExpand(v, newerNeighbour)}
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
                      {isNewest && liveSnapshotError && (
                        <p className="border-destructive/50 bg-destructive/5 text-destructive rounded border px-2 py-1 text-xs">
                          {liveSnapshotError}
                        </p>
                      )}
                      {(rowLoading || neighbourLoading || (isNewest && !liveSnapshot)) && !diff && (
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
          {restoreError && <p className="text-destructive text-sm">{restoreError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRestore()} disabled={restoring}>
              {restoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
