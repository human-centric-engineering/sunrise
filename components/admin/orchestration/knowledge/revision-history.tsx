'use client';

// Revision history for a Document Clean Up session: the list of every
// mutation, and a diff of whichever one you select. Shared by the History tab
// in the cleanup page's preview pane and the History dialog in the page
// header, so the two can never drift.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import {
  DiffModeToggle,
  TextDiffViewer,
  type DiffMode,
} from '@/components/admin/orchestration/knowledge/text-diff-viewer';
import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { apiClient, apiErrorFromResponse } from '@/lib/api/client';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { DEFAULT_REVISION_RETENTION } from '@/lib/orchestration/knowledge/revision-retention';

interface RevisionRow {
  id: string;
  version: number;
  source: string;
  actorId: string | null;
  sectionMarker: string | null;
  instructions: string | null;
  createdAt: string;
  contentLength: number;
  charsDelta: number;
}

interface RevisionListResponse {
  revisions: RevisionRow[];
}

interface RevisionDetailResponse {
  revision: { version: number; content: string; source: string; createdAt: string };
  previous: { version: number; content: string } | null;
  previousPruned: boolean;
}

/** What the selected revision is diffed against. */
type CompareTarget = 'previous' | 'current';

interface RevisionHistoryProps {
  documentId: string;
  /** Live `processedContent`, for the "against current" comparison. */
  currentContent: string;
  /** Called after a successful restore so the page can refetch the document. */
  onRestored: () => void;
  /** Extra work after a restore — the dialog uses it to close itself. */
  onAfterRestore?: () => void;
  /** Re-fetch the list whenever this changes (e.g. the dialog opening). */
  refreshKey?: number;
}

export function formatRevisionSource(source: string): string {
  if (source.startsWith('capability:')) return `Agent: ${source.slice('capability:'.length)}`;
  if (source.startsWith('finalise:')) return `Finalise: ${source.slice('finalise:'.length)}`;
  if (source === 'human_full') return 'You: whole-doc edit';
  if (source === 'human_section') return 'You: section edit';
  if (source === 'restore') return 'You: restore';
  return source;
}

export function RevisionHistory({
  documentId,
  currentContent,
  onRestored,
  onAfterRestore,
  refreshKey = 0,
}: RevisionHistoryProps) {
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [detail, setDetail] = useState<RevisionDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  // Load errors (the list, a revision). A failed restore shows by its button.
  const [error, setError] = useState<string | null>(null);
  const restoreFailure = useSaveFailure({
    fallback: 'Could not restore that version. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const { clear: clearRestoreFailure, report: reportRestoreFailure } = restoreFailure;
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('previous');
  const [mode, setMode] = useState<DiffMode>('unified');

  const fetchRevisions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.get<RevisionListResponse>(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/revisions`
      );
      setRevisions(body.revisions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load revisions');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void fetchRevisions();
  }, [fetchRevisions, refreshKey]);

  // The list endpoint sends metadata only — every revision row holds the whole
  // document, so content is fetched one revision at a time, on selection.
  useEffect(() => {
    clearRestoreFailure();
    if (selectedVersion === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    apiClient
      .get<RevisionDetailResponse>(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/revisions/${selectedVersion}`
      )
      .then((body) => {
        if (!cancelled) setDetail(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetail(null);
          setError(err instanceof Error ? err.message : 'Failed to load that revision');
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, selectedVersion, clearRestoreFailure]);

  const selected = useMemo(
    () => revisions.find((r) => r.version === selectedVersion) ?? null,
    [revisions, selectedVersion]
  );

  const restore = useCallback(
    async (version: number) => {
      setRestoring(version);
      clearRestoreFailure();
      try {
        const res = await fetch(
          `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/revisions/${version}/restore`,
          { method: 'POST' }
        );
        if (!res.ok) throw await apiErrorFromResponse(res);
        onRestored();
        onAfterRestore?.();
      } catch (err) {
        reportRestoreFailure(err);
      } finally {
        setRestoring(null);
      }
    },
    [documentId, onRestored, onAfterRestore, clearRestoreFailure, reportRestoreFailure]
  );

  // "previous" answers "what did this step change?"; "current" answers "what
  // would restoring it undo?".
  const diffPair =
    detail === null
      ? null
      : compareTarget === 'previous'
        ? { before: detail.previous?.content ?? '', after: detail.revision.content }
        : { before: detail.revision.content, after: currentContent };

  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {revisions.length >= DEFAULT_REVISION_RETENTION ? (
        <p className="text-muted-foreground text-xs" data-testid="revision-retention-hint">
          Showing the latest {DEFAULT_REVISION_RETENTION} revisions — older entries have been pruned
          to bound storage.
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="max-h-[55vh] overflow-auto rounded-md border">
          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center p-6 text-sm">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : revisions.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">No revisions yet.</p>
          ) : (
            <ul>
              {revisions.map((rev) => {
                const active = selectedVersion === rev.version;
                const sign = rev.charsDelta > 0 ? '+' : rev.charsDelta < 0 ? '−' : '±';
                return (
                  <li
                    key={rev.id}
                    className={`hover:bg-muted/40 border-b text-xs transition ${active ? 'bg-muted/60' : ''}`}
                  >
                    <button
                      type="button"
                      className="w-full cursor-pointer px-3 py-2 text-left"
                      onClick={() => setSelectedVersion(rev.version)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">v{rev.version}</span>
                        <span className="text-muted-foreground">
                          {new Date(rev.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-muted-foreground mt-1">
                        {formatRevisionSource(rev.source)}
                      </div>
                      {rev.sectionMarker ? (
                        <div className="text-muted-foreground mt-0.5">
                          Section: {rev.sectionMarker}
                        </div>
                      ) : null}
                      <div className="text-muted-foreground mt-0.5">
                        {rev.contentLength.toLocaleString()} chars ({sign}
                        {Math.abs(rev.charsDelta).toLocaleString()})
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          {selected === null ? (
            <p className="text-muted-foreground text-sm">
              Select a revision to see what it changed.
            </p>
          ) : (
            <>
              <SaveError failure={restoreFailure.failure} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">v{selected.version}</span>
                  <select
                    aria-label="Compare against"
                    className="bg-background rounded-md border px-1.5 py-0.5 text-[11px]"
                    value={compareTarget}
                    onChange={(e) => setCompareTarget(e.target.value as CompareTarget)}
                  >
                    <option value="previous">what this revision changed</option>
                    <option value="current">against the current document</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <DiffModeToggle mode={mode} onChange={setMode} />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void restore(selected.version)}
                    disabled={restoring !== null}
                  >
                    {restoring === selected.version ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1 h-3 w-3" />
                    )}
                    Restore this version
                  </Button>
                </div>
              </div>

              {detailLoading ? (
                <div className="text-muted-foreground flex items-center p-3 text-xs">
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading revision…
                </div>
              ) : diffPair === null ? null : (
                <>
                  {compareTarget === 'previous' && detail?.previousPruned ? (
                    <p className="text-muted-foreground text-xs">
                      The revision before this one has been pruned, so this shows v
                      {selected.version} in full rather than only what it changed.
                    </p>
                  ) : null}
                  <TextDiffViewer
                    before={diffPair.before}
                    after={diffPair.after}
                    mode={mode}
                    beforeLabel={
                      compareTarget === 'previous'
                        ? detail?.previous
                          ? `v${detail.previous.version}`
                          : 'empty'
                        : `v${selected.version}`
                    }
                    afterLabel={compareTarget === 'previous' ? `v${selected.version}` : 'current'}
                    maxHeightClass="max-h-[45vh]"
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
