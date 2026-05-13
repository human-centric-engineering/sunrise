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
import { useRouter } from 'next/navigation';
import { Save, Tag as TagIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';

interface TagRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

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
  const router = useRouter();
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [originalTagIds, setOriginalTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function save(): Promise<void> {
    if (!documentId) return;
    setSaving(true);
    setError(null);
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
      setError(err instanceof APIClientError ? err.message : 'Failed to save tags');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="h-5 w-5" />
            Tags — {documentName ?? 'Document'}
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
                see <em>Indexed keywords</em> on the Manage tab — that&apos;s a separate concept.
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

          {loading ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : allTags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No tags exist yet. Create some under <em>Knowledge → Tags</em>.
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
                          <div className="truncate font-medium">{tag.name}</div>
                          {tag.description ? (
                            <div className="text-muted-foreground truncate text-xs">
                              {tag.description}
                            </div>
                          ) : (
                            <div className="text-muted-foreground truncate font-mono text-xs">
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

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={!dirty || saving || loading}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save tags'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
