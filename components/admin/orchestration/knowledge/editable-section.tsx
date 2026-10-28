'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Pencil, Sparkles } from 'lucide-react';

import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiErrorFromResponse } from '@/lib/api/client';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { sha256Hex } from '@/lib/orchestration/knowledge/cleanup-client';
import type { Section } from '@/lib/orchestration/knowledge/section-detection';

interface EditableSectionProps {
  documentId: string;
  section: Section;
  /**
   * Context window (in tokens) of the cleanup conversation's bound model.
   * Used to compute the section size badge and disable refine when the
   * section would exceed budget. The server-side guard in
   * /cleanup/section/refine remains the authoritative check.
   */
  contextWindow: number;
  /** Acquire the doc-level edit lock. Resolves true on success. */
  acquireLock: () => Promise<boolean>;
  /** Called when this section is saved successfully — host refetches the doc. */
  onSaved: () => void;
  /** Called when "Refine with agent" produces a pending change — host opens the diff modal. */
  onPendingChange: (pendingChangeId: string) => void;
}

// Mirrors RESPONSE_TOKEN_BUDGET in /cleanup/section/refine/route.ts. Kept as
// a sibling constant so the UI's "would refine fit?" prediction matches the
// server's gate.
const RESPONSE_TOKEN_BUDGET = 4_096;
// 4 chars/token is a coarse but stable approximation across English text.
// The server uses a model-aware tokeniser; this client-side estimate is for
// signalling only — the server stays authoritative.
const CHARS_PER_TOKEN = 4;
const SOFT_WARNING_RATIO = 0.8;

function estimateSectionTokens(body: string): number {
  return Math.ceil(body.length / CHARS_PER_TOKEN);
}

interface ConflictState {
  currentBody: string;
  currentFingerprint: string;
}

// Single section view, with hover-to-reveal pencil that swaps to a textarea
// editor. On save, computes a SHA-256 of the section.body the editor opened
// against, POSTs to the cleanup/section endpoint, and surfaces 423 / 409
// errors with appropriate recovery UX.
export function EditableSection({
  documentId,
  section,
  contextWindow,
  acquireLock,
  onSaved,
  onPendingChange,
}: EditableSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body);
  // The body this editor opened against. `section.body` is a prop derived
  // from the parent's processedContent, which refetches on every chat turn
  // and capability result — fingerprinting it at save time would match the
  // server's *new* content and silently overwrite whatever landed mid-edit.
  // Captured once at startEdit so the 409 CONTENT_MISMATCH guard can fire.
  const [baselineBody, setBaselineBody] = useState(section.body);
  const [saving, setSaving] = useState(false);
  // A failed refine (an agent proposal, not a save). A failed save shows in
  // the save error by Save; a 409 shows the conflict panel instead.
  const [error, setError] = useState<string | null>(null);
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the section. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const { clear: clearSaveFailure, report: reportSaveFailure, show: showSaveFailure } = saveFailure;
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineInstructions, setRefineInstructions] = useState('');
  const [refinePromptOpen, setRefinePromptOpen] = useState(false);

  // Reset draft when section.body changes from underneath (capability fired
  // OR a refetch surfaced server-side updates) and we're NOT mid-edit.
  useEffect(() => {
    if (!editing) {
      setDraft(section.body);
      setBaselineBody(section.body);
    }
  }, [section.body, editing]);

  const startEdit = useCallback(async () => {
    setError(null);
    clearSaveFailure();
    setConflict(null);
    // Acquire the lock first — bail if another admin holds it.
    const ok = await acquireLock();
    if (!ok) return;
    setDraft(section.body);
    setBaselineBody(section.body);
    setEditing(true);
  }, [acquireLock, section.body, clearSaveFailure]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(section.body);
    setError(null);
    clearSaveFailure();
    setConflict(null);
  }, [section.body, clearSaveFailure]);

  const save = useCallback(
    async (overrideFingerprint?: string) => {
      setSaving(true);
      setError(null);
      clearSaveFailure();
      try {
        const expectedFingerprint = overrideFingerprint ?? (await sha256Hex(baselineBody));
        const res = await fetch(
          `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/section`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              // Addressed by id, not marker: markers repeat within a document
              // (duplicate headings, repeated speakers), so a marker would
              // fingerprint — and splice over — the first match instead.
              sectionId: section.id,
              content: draft,
              expectedFingerprint,
            }),
          }
        );
        if (res.status === 423) {
          showSaveFailure('Another admin is editing this document. Your changes were not saved.');
          return;
        }
        if (res.status === 409) {
          const body = (await res.json()) as {
            error?: { details?: { currentBody?: string[]; currentFingerprint?: string[] } };
          };
          const currentBody = body.error?.details?.currentBody?.[0] ?? '';
          const currentFingerprint = body.error?.details?.currentFingerprint?.[0] ?? '';
          setConflict({ currentBody, currentFingerprint });
          return;
        }
        if (!res.ok) throw await apiErrorFromResponse(res);
        setEditing(false);
        setConflict(null);
        onSaved();
      } catch (err) {
        reportSaveFailure(err);
      } finally {
        setSaving(false);
      }
    },
    [
      documentId,
      draft,
      baselineBody,
      section.id,
      onSaved,
      clearSaveFailure,
      reportSaveFailure,
      showSaveFailure,
    ]
  );

  const keepMine = useCallback(() => {
    if (!conflict) return;
    // Re-save with the server's current fingerprint — overwrites the other
    // writer's change with the local draft.
    void save(conflict.currentFingerprint);
  }, [conflict, save]);

  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    setDraft(conflict.currentBody);
    // The server's version is now what this editor is based on, so a later
    // plain Save fingerprints against it rather than the stale original.
    setBaselineBody(conflict.currentBody);
    setConflict(null);
    setError(null);
    clearSaveFailure();
    // Stay in edit mode so the admin can hand-merge if they want.
  }, [conflict, clearSaveFailure]);

  const refineWithAgent = useCallback(async () => {
    if (refineInstructions.trim().length === 0) return;
    setRefining(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/section/refine`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionId: section.id,
            instructions: refineInstructions.trim(),
          }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Refine failed (${res.status})`);
      }
      const body = (await res.json()) as { data?: { pendingChangeId?: string } };
      if (body.data?.pendingChangeId) {
        onPendingChange(body.data.pendingChangeId);
      }
      setRefinePromptOpen(false);
      setRefineInstructions('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refine failed');
    } finally {
      setRefining(false);
    }
  }, [documentId, refineInstructions, section.id, onPendingChange]);

  // Live diff strip — char/line delta vs. the saved baseline (section.body).
  const draftCharsDelta = draft.length - section.body.length;
  const draftLinesDelta = draft.split('\n').length - section.body.split('\n').length;

  // Size-vs-context-window prediction. Driven by the live draft (in edit
  // mode) or the saved body (in view mode). The ratio drives the badge tint
  // and the refine-button gating.
  const sizeSourceBody = editing ? draft : section.body;
  const estimatedTokens = estimateSectionTokens(sizeSourceBody);
  const refineBudgetTokens = estimatedTokens + RESPONSE_TOKEN_BUDGET;
  const sizeRatio = contextWindow > 0 ? refineBudgetTokens / contextWindow : 0;
  const sizeOverBudget = sizeRatio >= 1;
  const sizeNearBudget = !sizeOverBudget && sizeRatio >= SOFT_WARNING_RATIO;
  const sizeBadgeClass = sizeOverBudget
    ? 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200'
    : sizeNearBudget
      ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
      : 'bg-muted text-muted-foreground';
  const refineDisabledReason = sizeOverBudget
    ? `Section is too large for this model's context window (${estimatedTokens.toLocaleString()} tokens + 4k response budget exceeds ${contextWindow.toLocaleString()}). Split it or switch model.`
    : null;

  if (!editing) {
    return (
      <div className="group relative border-b last:border-b-0">
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {sizeNearBudget || sizeOverBudget ? (
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${sizeBadgeClass}`}
              title={
                sizeOverBudget
                  ? (refineDisabledReason ?? '')
                  : `Approaching model context window — ${Math.round(sizeRatio * 100)}% of ${contextWindow.toLocaleString()} tokens.`
              }
            >
              ~{estimatedTokens.toLocaleString()} tok
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`Edit section ${section.marker}`}
            onClick={() => void startEdit()}
            className="text-muted-foreground hover:bg-muted hover:text-foreground hidden rounded-md p-1 opacity-0 transition group-hover:flex group-hover:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
        <pre className="overflow-auto p-3 text-xs whitespace-pre-wrap">{section.body}</pre>
      </div>
    );
  }

  return (
    <div className="bg-muted/20 border-b last:border-b-0">
      <div className="text-muted-foreground border-b px-3 py-1 text-xs font-medium">
        Editing: {section.marker}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="bg-background block w-full resize-y p-3 font-mono text-xs whitespace-pre-wrap focus:outline-none"
        rows={Math.max(4, Math.min(20, draft.split('\n').length))}
        disabled={saving}
      />
      {error ? (
        <div className="border-destructive/20 bg-destructive/5 text-destructive flex items-start gap-2 border-t p-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {conflict ? (
        <div className="border-t border-amber-300/40 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
          <div className="font-medium">Section changed since you started editing.</div>
          <div className="mt-1">
            Choose: <strong>Keep mine</strong> overwrites the new server version with your edit;{' '}
            <strong>Take theirs</strong> discards your edit and loads the new version into the
            textarea.
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={keepMine} disabled={saving}>
              Keep mine
            </Button>
            <Button size="sm" variant="outline" onClick={takeTheirs} disabled={saving}>
              Take theirs
            </Button>
          </div>
        </div>
      ) : null}
      {refinePromptOpen ? (
        <div className="bg-muted/40 border-t p-2">
          <label
            htmlFor="cleanup-refine-instructions"
            className="text-muted-foreground mb-1 block text-xs font-medium"
          >
            Tell the agent what to do with this section
          </label>
          <div className="flex gap-2">
            <Input
              id="cleanup-refine-instructions"
              value={refineInstructions}
              onChange={(e) => setRefineInstructions(e.target.value)}
              placeholder="e.g. shorten to one paragraph; remove filler words"
              disabled={refining}
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              onClick={() => void refineWithAgent()}
              disabled={refining || refineInstructions.trim().length === 0}
            >
              {refining ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Refine
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRefinePromptOpen(false)}
              disabled={refining}
            >
              Cancel
            </Button>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            The agent&apos;s rewrite opens as a diff card for you to Accept or Reject — it
            doesn&apos;t replace your edit until you do.
          </p>
        </div>
      ) : null}
      <div className="border-t px-3 pt-2 empty:hidden">
        <SaveError failure={saveFailure.failure} />
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <span>
            {draft.length.toLocaleString()} chars · {draft.split('\n').length} lines
            {draftCharsDelta !== 0 ? (
              <>
                {' · '}
                <span
                  className={
                    draftCharsDelta < 0
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-amber-700 dark:text-amber-300'
                  }
                >
                  {draftCharsDelta > 0 ? '+' : ''}
                  {draftCharsDelta.toLocaleString()} chars
                  {draftLinesDelta !== 0
                    ? `, ${draftLinesDelta > 0 ? '+' : ''}${draftLinesDelta} lines`
                    : ''}
                </span>
              </>
            ) : null}
          </span>
          {sizeNearBudget || sizeOverBudget ? (
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${sizeBadgeClass}`}
              title={
                sizeOverBudget
                  ? (refineDisabledReason ?? '')
                  : `Approaching model context window — ${Math.round(sizeRatio * 100)}% of ${contextWindow.toLocaleString()} tokens.`
              }
            >
              ~{estimatedTokens.toLocaleString()} tok
            </span>
          ) : null}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRefinePromptOpen(true)}
            disabled={saving || refining || refinePromptOpen || sizeOverBudget}
            title={refineDisabledReason ?? undefined}
          >
            <Sparkles className="mr-1 h-3 w-3" />
            Refine with agent
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={saving || refining}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || refining}>
            {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
