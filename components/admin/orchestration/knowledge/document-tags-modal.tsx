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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

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

  const tagOptions = useMemo<MultiSelectOption[]>(
    () =>
      allTags.map((t) => ({
        value: t.id,
        label: t.name,
        description: t.description ?? t.slug,
      })),
    [allTags]
  );

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
            <Label htmlFor="doc-tags-modal" className="text-sm">
              Tags
            </Label>
            <FieldHelp title="Knowledge tags">
              <p>
                Manage the tag taxonomy under <em>Knowledge → Tags</em>. System-scoped documents are
                visible to every agent regardless of tags — tagging them is still useful for
                filtering and organisation.
              </p>
            </FieldHelp>
          </div>

          {loading ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : allTags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No tags exist yet. Create some under <em>Knowledge → Tags</em>.
            </p>
          ) : (
            <MultiSelect
              id="doc-tags-modal"
              value={tagIds}
              onChange={setTagIds}
              options={tagOptions}
              placeholder="No tags applied"
              emptyText="No matching tags."
            />
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
