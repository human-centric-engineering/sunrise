'use client';

/**
 * Edit a document's tag grants without leaving the document list.
 *
 * Click the "N tags" count chip on a row → this modal opens with the tag
 * MultiSelect pre-seeded from the current grants. Saving PATCHes
 * `/admin/orchestration/knowledge/documents/[id]` with the new tagIds and
 * invalidates the resolver cache so agents pick up the change on the next
 * chat turn.
 *
 * Stays separate from `DocumentChunksModal` so each modal has one job — the
 * chunks modal is for inspecting parser output, this one is for editing
 * which agents can find the doc.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Plus, Save, Tag as TagIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSharedSettingsReadOnly } from '@/components/admin/shared-settings-access';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SaveError } from '@/components/forms/form-error';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { createKnowledgeTagSchema } from '@/lib/validations/orchestration';
import { cn } from '@/lib/utils';

interface TagRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

/** Slug regex mirrors `createKnowledgeTagSchema` — keep an auto-derived slug shape-valid. */
function slugifyTagName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface CreateFieldErrors {
  name?: string;
  slug?: string;
  description?: string;
}

/**
 * Server path → the id of the create-tag input that shows its message, so the
 * save error can focus it (`.context/ui/form-errors.md`).
 */
const CREATE_TAG_FIELDS: Partial<Record<string, string>> = {
  name: 'new-tag-name',
  slug: 'new-tag-slug',
  description: 'new-tag-description',
};
const CREATE_TAG_KEYS = ['name', 'slug', 'description'] as const;

export interface DocumentTagsModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved?: () => void;
}

export function DocumentTagsModal({
  documentId,
  documentName,
  open,
  onOpenChange,
  onSaved,
}: DocumentTagsModalProps): React.ReactElement {
  const readOnly = useSharedSettingsReadOnly();
  const router = useRouter();
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [originalTagIds, setOriginalTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // The load error; a failed save shows above the footer instead.
  const [error, setError] = useState<string | null>(null);
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the tags. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const clearSaveFailure = saveFailure.clear;

  const fetchTagsAndDoc = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    try {
      const [allTagRows, docPayload] = await Promise.all([
        apiClient.get<TagRow[]>(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=100`),
        apiClient.get<{ document: { tagIds?: string[] } }>(
          API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId)
        ),
      ]);
      setAllTags(Array.isArray(allTagRows) ? allTagRows : []);
      const current = docPayload?.document?.tagIds ?? [];
      setTagIds(current);
      setOriginalTagIds(current);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    if (open && documentId) {
      void fetchTagsAndDoc();
    }
    if (!open) {
      setAllTags([]);
      setTagIds([]);
      setOriginalTagIds([]);
      setError(null);
    }
  }, [open, documentId, fetchTagsAndDoc]);

  // Inline tag-creation state. Operators who realise a tag is missing
  // can spin one up without leaving the modal — the new tag is added to
  // `allTags`, auto-selected, and the form collapses back to the list.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSlug, setCreateSlug] = useState('');
  const [createSlugDirty, setCreateSlugDirty] = useState(false);
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createFieldErrors, setCreateFieldErrors] = useState<CreateFieldErrors>({});
  const createFailure = useSaveFailure({
    fallback: 'Could not create the tag. Try again.',
    fields: CREATE_TAG_FIELDS,
  });
  const clearCreateFailure = createFailure.clear;

  useEffect(() => {
    if (!open) {
      setCreateOpen(false);
      setCreateName('');
      setCreateSlug('');
      setCreateSlugDirty(false);
      setCreateDescription('');
      setCreateFieldErrors({});
    }
  }, [open]);

  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!open) setFilter('');
  }, [open]);

  const filteredTags = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false)
    );
  }, [allTags, filter]);

  const selectedSet = useMemo(() => new Set(tagIds), [tagIds]);

  function toggle(id: string): void {
    if (selectedSet.has(id)) {
      setTagIds(tagIds.filter((v) => v !== id));
    } else {
      setTagIds([...tagIds, id]);
    }
  }

  const dirty = useMemo(() => {
    if (tagIds.length !== originalTagIds.length) return true;
    const a = [...tagIds].sort();
    const b = [...originalTagIds].sort();
    return a.some((v, i) => v !== b[i]);
  }, [tagIds, originalTagIds]);

  async function createTag(): Promise<void> {
    createFailure.clear();
    const payload = {
      slug: createSlug.trim(),
      name: createName.trim(),
      description: createDescription.trim() || undefined,
    };

    // Client-side validation mirrors the server's schema so operators see
    // field-level feedback without a network round-trip.
    const parsed = createKnowledgeTagSchema.safeParse(payload);
    if (!parsed.success) {
      const next: CreateFieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === 'slug' || key === 'name' || key === 'description') && !next[key]) {
          next[key] = issue.message;
        }
      }
      setCreateFieldErrors(next);
      return;
    }

    setCreateBusy(true);
    setCreateFieldErrors({});
    try {
      const created = await apiClient.post<TagRow>(API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS, {
        body: payload,
      });
      // Inject the new tag into the local list and auto-select it so the
      // operator's intent ("I want this doc to carry this new tag") is
      // honoured without an extra click.
      setAllTags((prev) =>
        prev.some((t) => t.id === created.id)
          ? prev
          : [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
      );
      setTagIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      // Collapse the form, reset state.
      setCreateOpen(false);
      setCreateName('');
      setCreateSlug('');
      setCreateSlugDirty(false);
      setCreateDescription('');
    } catch (err) {
      // The summary shows above Create; a field the server named gets its
      // message under the input, which the summary's focus lands on.
      const failure = createFailure.report(err);
      const next: CreateFieldErrors = {};
      for (const key of CREATE_TAG_KEYS) {
        const placed = failure.fields.find((f) => f.field === CREATE_TAG_FIELDS[key]);
        if (placed) next[key] = placed.message;
      }
      setCreateFieldErrors(next);
    } finally {
      setCreateBusy(false);
    }
  }

  // Committed while a save or a tag create is in flight; both failures are
  // cleared each time it opens.
  const dialog = useCommittedDialog({
    open,
    pending: saving || createBusy,
    onOpen: () => onOpenChange(true),
    onClose: () => onOpenChange(false),
    clear: () => {
      clearSaveFailure();
      clearCreateFailure();
    },
  });

  async function save(): Promise<void> {
    if (!documentId) return;
    setSaving(true);
    saveFailure.clear();
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId), {
        body: { tagIds },
      });
      setOriginalTagIds(tagIds);
      // Refresh the parent server-rendered list so the count chip updates
      // when the modal closes.
      router.refresh();
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      saveFailure.report(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={dialog.onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-start gap-2">
            <TagIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <span className="min-w-0 break-words">Tags — {documentName ?? 'Document'}</span>
          </DialogTitle>
          <DialogDescription>
            Apply or remove tags. Agents running in <em>Restricted</em> knowledge mode can search
            this document when granted any of these tags.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex items-center gap-1">
            <Label className="text-sm">Tags</Label>
            <FieldHelp title="Knowledge tags">
              <p>
                Tags control <em>which</em> docs an agent can search when its knowledge access is
                set to <strong>Restricted</strong>. To improve <em>how</em> a doc ranks for a query,
                use the per-row <em>Enrich keywords</em> action on the Manage tab — that&apos;s a
                separate concept.
              </p>
              <p className="mt-2">
                Manage the tag taxonomy under <em>Knowledge → Tags</em>. System-scoped documents are
                visible to every agent regardless of tags — tagging them is still useful for
                filtering and organisation.
              </p>
            </FieldHelp>
            {!loading && allTags.length > 0 ? (
              <span className="text-muted-foreground ml-auto text-xs">
                {tagIds.length} of {allTags.length} selected
              </span>
            ) : null}
          </div>

          {/* Always-visible affordances: spin up a new tag inline, or open
              the full Tags admin in a new tab for richer management
              (rename, delete, drill-down). New-tab keeps the operator's
              in-progress selections in this modal intact. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Tags are shared settings: created from the install org only at
                `multi` (§107 t-753). Applying an existing tag is this org's. */}
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setCreateOpen((v) => !v)}
                disabled={loading}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {createOpen ? 'Cancel new tag' : 'Create new tag'}
              </Button>
            )}
            <Link
              href="/admin/orchestration/knowledge/tags"
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
            >
              Manage all tags
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          {/* Not redundant with the hidden toggle: a refresh that flips this
              page read-only keeps client state, so a form already open must
              close too. */}
          {createOpen && !readOnly ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="new-tag-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="new-tag-name"
                  value={createName}
                  onChange={(e) => {
                    const next = e.target.value;
                    setCreateName(next);
                    setCreateFieldErrors((p) => ({ ...p, name: undefined }));
                    if (!createSlugDirty) {
                      setCreateSlug(slugifyTagName(next));
                      setCreateFieldErrors((p) => ({ ...p, slug: undefined }));
                    }
                  }}
                  placeholder="e.g. Customer Support"
                  className="h-8 text-sm"
                  disabled={createBusy}
                  aria-invalid={createFieldErrors.name ? true : undefined}
                />
                {createFieldErrors.name ? (
                  <p className="text-destructive text-xs">{createFieldErrors.name}</p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-tag-slug" className="text-xs">
                  Slug
                </Label>
                <Input
                  id="new-tag-slug"
                  value={createSlug}
                  onChange={(e) => {
                    setCreateSlugDirty(true);
                    setCreateSlug(e.target.value);
                    setCreateFieldErrors((p) => ({ ...p, slug: undefined }));
                  }}
                  placeholder="e.g. customer-support"
                  className="h-8 text-sm"
                  disabled={createBusy}
                  aria-invalid={createFieldErrors.slug ? true : undefined}
                />
                {createFieldErrors.slug ? (
                  <p className="text-destructive text-xs">{createFieldErrors.slug}</p>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Lowercase letters, numbers, and hyphens only. Auto-derived from the name until
                    you edit it.
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-tag-description" className="text-xs">
                  Description (optional)
                </Label>
                <Textarea
                  id="new-tag-description"
                  value={createDescription}
                  onChange={(e) => {
                    setCreateDescription(e.target.value);
                    setCreateFieldErrors((p) => ({ ...p, description: undefined }));
                  }}
                  rows={2}
                  placeholder="What kind of documents belong under this tag?"
                  disabled={createBusy}
                  aria-invalid={createFieldErrors.description ? true : undefined}
                />
                {createFieldErrors.description ? (
                  <p className="text-destructive text-xs">{createFieldErrors.description}</p>
                ) : null}
              </div>
              <SaveError failure={createFailure.failure} />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCreateOpen(false);
                    createFailure.clear();
                    setCreateFieldErrors({});
                  }}
                  disabled={createBusy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void createTag()}
                  disabled={createBusy}
                >
                  {createBusy ? 'Creating…' : 'Create & apply'}
                </Button>
              </div>
            </div>
          ) : null}

          {loading ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : allTags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No tags exist yet. Use <strong>Create new tag</strong> above, or open the full Tags
              admin via <strong>Manage all tags</strong>.
            </p>
          ) : (
            <div className="rounded-md border">
              <div className="border-b p-2">
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter tags…"
                  aria-label="Filter tags"
                  className="h-8"
                />
              </div>
              <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-multiselectable>
                {filteredTags.length === 0 ? (
                  <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                    No tags match &ldquo;{filter}&rdquo;.
                  </p>
                ) : (
                  filteredTags.map((tag) => {
                    const checked = selectedSet.has(tag.id);
                    return (
                      <label
                        key={tag.id}
                        className={cn(
                          'hover:bg-muted/60 flex cursor-pointer items-start gap-2 px-3 py-2 text-sm',
                          checked && 'bg-muted/40'
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(tag.id)}
                          className="mt-0.5"
                          aria-label={`${checked ? 'Remove' : 'Apply'} tag ${tag.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium break-words">{tag.name}</div>
                          {tag.description ? (
                            <div className="text-muted-foreground text-xs break-words">
                              {tag.description}
                            </div>
                          ) : (
                            <div className="text-muted-foreground font-mono text-xs break-words">
                              {tag.slug}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              {tagIds.length > 0 ? (
                <div className="flex items-center justify-between border-t px-2 py-1.5">
                  <span className="text-muted-foreground text-xs">{tagIds.length} selected</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setTagIds([])}
                  >
                    Clear all
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>

        <SaveError failure={saveFailure.failure} />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} {...dialog.cancelProps}>
            Cancel
          </Button>
          <Button
            {...dialog.actionProps({ disabled: !dirty || loading })}
            onClick={(e) => dialog.confirm(e, save)}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save tags'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
