'use client';

/**
 * Knowledge Access section of the agent form.
 *
 * Radio: Full | Restricted. When `Restricted` is chosen the agent's effective
 * knowledge corpus is the union of (granted documents) ∪ (documents carrying
 * any granted tag) ∪ (system-scoped seed docs). System docs always pass through
 * the resolver and don't need explicit grants — see FieldHelp.
 *
 * Two MultiSelects:
 *   - Tags  → static list, loaded once via `GET /knowledge/tags`.
 *   - Docs  → async search via `GET /knowledge/documents?q=` (the doc count
 *     can run into the hundreds so eager loading is impractical).
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export type KnowledgeAccessMode = 'full' | 'restricted';

interface TagRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

interface DocumentRow {
  id: string;
  name: string;
  fileName: string;
}

export interface KnowledgeAccessSectionProps {
  mode: KnowledgeAccessMode;
  tagIds: string[];
  documentIds: string[];
  onModeChange: (next: KnowledgeAccessMode) => void;
  onTagsChange: (next: string[]) => void;
  onDocumentsChange: (next: string[]) => void;
}

export function KnowledgeAccessSection({
  mode,
  tagIds: rawTagIds,
  documentIds: rawDocumentIds,
  onModeChange,
  onTagsChange,
  onDocumentsChange,
}: KnowledgeAccessSectionProps): React.ReactElement {
  // RHF can hand back `undefined` on the first render before the schema
  // defaults settle; coerce up front so the MultiSelect never sees a
  // missing value.
  const tagIds = rawTagIds ?? [];
  const documentIds = rawDocumentIds ?? [];
  const [tags, setTags] = useState<TagRow[]>([]);
  const [selectedDocLabels, setSelectedDocLabels] = useState<Record<string, string>>({});

  // Load the full tag list once. Tags are managed admin entities — there
  // typically aren't more than a few dozen, so eager-load is fine.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tagList = await apiClient.get<TagRow[]>(
          `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=200`
        );
        if (!cancelled) setTags(Array.isArray(tagList) ? tagList : []);
      } catch {
        // Non-fatal: form remains usable, MultiSelect just shows an empty list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the agent loads with existing doc grants we need labels for the chips.
  // The async MultiSelect's loadOptions only knows what the user types — fetch
  // the selected docs up front so their chips render correctly.
  useEffect(() => {
    if (documentIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        // The documents list endpoint doesn't filter by id, so we fetch a page
        // and pick the relevant rows. For agents with hundreds of grants this
        // is imperfect — but Phase 4 deliberately keeps the doc picker scope
        // to "names users would recognise", which fits inside the first page.
        const docs = await apiClient.get<DocumentRow[]>(
          `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS}?limit=200`
        );
        if (cancelled) return;
        const labels: Record<string, string> = {};
        for (const doc of docs ?? []) {
          if (documentIds.includes(doc.id)) labels[doc.id] = doc.name;
        }
        setSelectedDocLabels(labels);
      } catch {
        // Non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentIds]);

  const tagOptions = useMemo<MultiSelectOption[]>(
    () =>
      (tags ?? []).map((t) => ({
        value: t.id,
        label: t.name,
        description: t.description ?? t.slug,
      })),
    [tags]
  );

  async function loadDocumentOptions(query: string): Promise<MultiSelectOption[]> {
    const url = new URL(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS, window.location.origin);
    url.searchParams.set('limit', '50');
    if (query.trim()) url.searchParams.set('q', query.trim());
    try {
      const docs = await apiClient.get<DocumentRow[]>(`${url.pathname}${url.search}`);
      return (docs ?? []).map((doc) => ({
        value: doc.id,
        label: doc.name,
        description: doc.fileName,
      }));
    } catch {
      return [];
    }
  }

  const showEmptyRestrictedWarning =
    mode === 'restricted' && tagIds.length === 0 && documentIds.length === 0;

  return (
    <div className="grid gap-3 rounded-md border p-4">
      <div>
        <Label className="text-base">
          Knowledge access{' '}
          <FieldHelp title="Knowledge access mode">
            Controls which knowledge base documents this agent can search. <strong>Full</strong>{' '}
            (default) lets the agent see every document in the KB. <strong>Restricted</strong>{' '}
            scopes searches to (granted documents) ∪ (documents carrying any granted tag).
            System-seeded reference material is always visible regardless of mode.
          </FieldHelp>
        </Label>
      </div>

      <fieldset className="grid gap-2">
        <legend className="sr-only">Access mode</legend>
        <div className="flex items-start gap-2">
          <input
            id="knowledge-access-mode-full"
            type="radio"
            name="knowledgeAccessMode"
            value="full"
            checked={mode === 'full'}
            onChange={() => onModeChange('full')}
            className="mt-0.5"
          />
          <label htmlFor="knowledge-access-mode-full" className="text-sm">
            <span className="font-medium">Full access</span>
            <span className="text-muted-foreground block text-xs">
              Search every document in the KB.
            </span>
          </label>
        </div>
        <div className="flex items-start gap-2">
          <input
            id="knowledge-access-mode-restricted"
            type="radio"
            name="knowledgeAccessMode"
            value="restricted"
            checked={mode === 'restricted'}
            onChange={() => onModeChange('restricted')}
            className="mt-0.5"
          />
          <label htmlFor="knowledge-access-mode-restricted" className="text-sm">
            <span className="font-medium">Restricted</span>
            <span className="text-muted-foreground block text-xs">
              Scope searches to the documents and tags selected below (plus system-seeded reference
              material).
            </span>
          </label>
        </div>
      </fieldset>

      {mode === 'restricted' ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="knowledge-tags">
              Tags{' '}
              <FieldHelp title="Knowledge tag grants">
                Documents carrying any of these tags are visible to the agent. Tags are managed
                under <em>Knowledge → Tags</em>. Granting a tag covers every existing and future
                document with that tag.
              </FieldHelp>
            </Label>
            <MultiSelect
              id="knowledge-tags"
              value={tagIds}
              onChange={onTagsChange}
              options={tagOptions}
              placeholder="No tags granted"
              emptyText="No tags exist yet — create some under Knowledge → Tags."
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="knowledge-documents">
              Documents{' '}
              <FieldHelp title="Knowledge document grants">
                Specific documents this agent can search regardless of tags. Use this for one-off
                grants where a tag doesn&apos;t fit. Search is matched on document name/file name.
              </FieldHelp>
            </Label>
            <MultiSelect
              id="knowledge-documents"
              value={documentIds}
              onChange={onDocumentsChange}
              loadOptions={loadDocumentOptions}
              selectedLabels={selectedDocLabels}
              placeholder="No documents granted"
              emptyText="No matching documents."
            />
          </div>

          {showEmptyRestrictedWarning ? (
            <div className="bg-muted/40 flex items-start gap-2 rounded-md border p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">No grants selected</p>
                <p className="text-muted-foreground text-xs">
                  This agent will see only system-seeded reference material. That&apos;s rarely
                  intentional — add a tag or a document to scope its KB.
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
