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
import { cn } from '@/lib/utils';

export type KnowledgeAccessMode = 'full' | 'restricted';

/** Slug of the built-in capability that actually lets an agent search the KB. */
const SEARCH_CAPABILITY_SLUG = 'search_knowledge_base';

/**
 * Whether the agent has a working knowledge-search tool. Knowledge access
 * settings are inert without it, so the section gates on this.
 *   - `loading`  — fetch in flight (don't gate yet, avoid a flash)
 *   - `enabled`  — capability attached and enabled → settings apply
 *   - `disabled` — attached but the binding is switched off
 *   - `absent`   — no binding at all
 *   - `unknown`  — no agentId (create flow) or the fetch failed → don't gate
 */
type SearchCapabilityState = 'loading' | 'enabled' | 'disabled' | 'absent' | 'unknown';

interface AgentCapabilityLink {
  isEnabled: boolean;
  capability: { slug: string } | null;
}

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
  /**
   * Agent being edited. Used to check whether the knowledge-search capability
   * is attached — when it isn't, the section is greyed out because the access
   * settings have no effect. Omitted on the create flow (no agent yet, and
   * capabilities can only be attached after the first save), where no gating
   * is applied.
   */
  agentId?: string;
  /**
   * Read-only: the mode and grants are shown but cannot be changed — a
   * platform agent's are the platform's (§116). Unlike the capability gate
   * below, the field help stays usable.
   */
  disabled?: boolean;
}

export function KnowledgeAccessSection({
  mode,
  tagIds: rawTagIds,
  documentIds: rawDocumentIds,
  onModeChange,
  onTagsChange,
  onDocumentsChange,
  agentId,
  disabled = false,
}: KnowledgeAccessSectionProps): React.ReactElement {
  // RHF can hand back `undefined` on the first render before the schema
  // defaults settle; coerce up front so the MultiSelect never sees a
  // missing value.
  const tagIds = rawTagIds ?? [];
  // Memoised because `documentIds` is a useEffect dependency below — a fresh
  // `?? []` array each render would otherwise re-fire that effect every render.
  const documentIds = useMemo(() => rawDocumentIds ?? [], [rawDocumentIds]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [selectedDocLabels, setSelectedDocLabels] = useState<Record<string, string>>({});

  // Does the agent have a working knowledge-search tool? This section's
  // settings are inert without it. The fetch re-runs whenever the section
  // mounts — Radix unmounts inactive tab panels, so switching away to the
  // Capabilities tab to attach the tool and back re-checks automatically.
  const [searchCapability, setSearchCapability] = useState<SearchCapabilityState>(
    agentId ? 'loading' : 'unknown'
  );
  useEffect(() => {
    // No agent yet (create flow): initial state is already 'unknown', so leave
    // the section ungated — capabilities can only be attached after the first save.
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      setSearchCapability('loading');
      try {
        const links = await apiClient.get<AgentCapabilityLink[]>(
          API.ADMIN.ORCHESTRATION.agentCapabilities(agentId)
        );
        if (cancelled) return;
        const binding = (links ?? []).find((l) => l.capability?.slug === SEARCH_CAPABILITY_SLUG);
        setSearchCapability(
          binding === undefined ? 'absent' : binding.isEnabled ? 'enabled' : 'disabled'
        );
      } catch {
        // On a fetch failure, fall back to ungated rather than blocking the
        // form — the runtime still enforces access regardless of this hint.
        if (!cancelled) setSearchCapability('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const gated = searchCapability === 'absent' || searchCapability === 'disabled';

  // Load the full tag list once. Tags are managed admin entities — there
  // typically aren't more than a few dozen, so eager-load is fine.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tagList = await apiClient.get<TagRow[]>(
          `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=100`
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
          `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS}?limit=100`
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

      {gated ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-amber-900 dark:text-amber-100">
            <p className="font-medium">No knowledge-search capability attached</p>
            <p className="mt-0.5 text-xs">
              {searchCapability === 'disabled'
                ? 'The Search Knowledge Base capability is attached but switched off. Enable it on the Capabilities tab — until then this agent cannot search documents and these settings have no effect.'
                : 'Attach the Search Knowledge Base capability on the Capabilities tab. Until then this agent cannot search documents and these settings have no effect.'}
            </p>
          </div>
        </div>
      ) : null}

      <fieldset disabled={gated} className={cn('grid gap-3', gated && 'opacity-60')}>
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
              disabled={disabled}
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
              disabled={disabled}
              className="mt-0.5"
            />
            <label htmlFor="knowledge-access-mode-restricted" className="text-sm">
              <span className="font-medium">Restricted</span>
              <span className="text-muted-foreground block text-xs">
                Scope searches to the documents and tags selected below (plus system-seeded
                reference material).
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
                  <p>
                    Documents carrying any of these tags are visible to the agent. Tags are managed
                    under <em>Knowledge → Tags</em>. Granting a tag covers every existing and future
                    document with that tag.
                  </p>
                  <p className="mt-2">
                    Tags control <em>which</em> docs an agent can search. To improve <em>how</em> a
                    doc ranks for a query, use the per-row <em>Enrich keywords</em> action on the
                    Knowledge → Manage tab — that&apos;s a separate concept.
                  </p>
                </FieldHelp>
              </Label>
              <MultiSelect
                id="knowledge-tags"
                value={tagIds}
                onChange={onTagsChange}
                options={tagOptions}
                disabled={gated || disabled}
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
                disabled={gated || disabled}
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
      </fieldset>
    </div>
  );
}
