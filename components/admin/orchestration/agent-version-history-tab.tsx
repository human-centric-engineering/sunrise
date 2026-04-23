'use client';

/**
 * AgentVersionHistoryTab — full config version history.
 *
 * Edit-mode tab showing the AiAgentVersion timeline. Each row displays
 * version number, change summary, creator, and date. Expand to see the
 * full snapshot diff, and restore to roll back the agent to that version.
 *
 * Lazy-fetches versions on mount via GET /agents/:id/versions.
 */

import { useCallback, useEffect, useState } from 'react';
import { Clock, Loader2, RotateCcw } from 'lucide-react';

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

interface VersionEntry {
  id: string;
  version: number;
  changeSummary: string | null;
  createdBy: string;
  createdAt: string;
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

export function AgentVersionHistoryTab({ agentId, onRestored }: AgentVersionHistoryTabProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<VersionEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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
            description alone do not create a version. You can view what changed and restore any
            previous version. Restoring creates a new version entry so the action is auditable.
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
            {versions.map((v, idx) => (
              <li key={v.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px] tabular-nums">
                      v{v.version}
                    </Badge>
                    <span className="font-medium">
                      {v.changeSummary ?? 'Configuration updated'}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">{formatDate(v.createdAt)}</p>
                </div>
                {idx > 0 && (
                  <Button
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
              </li>
            ))}
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
