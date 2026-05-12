'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Save } from 'lucide-react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

const chunksResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      chunks: z.array(
        z.object({
          id: z.string(),
          content: z.string(),
          chunkType: z.string(),
          patternNumber: z.number().nullable(),
          patternName: z.string().nullable(),
          section: z.string().nullable(),
          category: z.string().nullable(),
          keywords: z.string().nullable(),
          estimatedTokens: z.number(),
        })
      ),
      coverage: z
        .object({
          parsedChars: z.number(),
          chunkChars: z.number(),
          coveragePct: z.number(),
        })
        .nullable()
        .optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
});

interface ChunkData {
  id: string;
  content: string;
  chunkType: string;
  patternNumber: number | null;
  patternName: string | null;
  section: string | null;
  category: string | null;
  keywords: string | null;
  estimatedTokens: number;
}

interface Coverage {
  parsedChars: number;
  chunkChars: number;
  coveragePct: number;
}

interface DocumentChunksModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TagRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

export function DocumentChunksModal({
  documentId,
  documentName,
  open,
  onOpenChange,
}: DocumentChunksModalProps) {
  const [chunks, setChunks] = useState<ChunkData[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tag editor state — separate fetch from the chunks call because /chunks
  // doesn't include doc-level metadata.
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [originalTagIds, setOriginalTagIds] = useState<string[]>([]);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const fetchChunks = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentChunks(documentId));
      if (!res.ok) {
        throw new Error(`Failed to load chunks (${res.status})`);
      }
      const body = chunksResponseSchema.parse(await res.json());
      setChunks(body.data?.chunks ?? []);
      setCoverage(body.data?.coverage ?? null);
      setWarnings(body.data?.warnings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chunks');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  const fetchTagsAndDoc = useCallback(async () => {
    if (!documentId) return;
    try {
      const [tagsRes, docRes] = await Promise.all([
        apiClient.get<{ data: TagRow[] }>(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=200`),
        apiClient.get<{ document: { tagIds?: string[] } }>(
          API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId)
        ),
      ]);
      setAllTags(tagsRes?.data ?? []);
      const current = docRes?.document?.tagIds ?? [];
      setTagIds(current);
      setOriginalTagIds(current);
      setTagError(null);
    } catch {
      // Non-fatal: chunks view still works, tag editor just shows no options.
    }
  }, [documentId]);

  useEffect(() => {
    if (open && documentId) {
      void fetchChunks();
      void fetchTagsAndDoc();
    }
    if (!open) {
      setChunks([]);
      setCoverage(null);
      setWarnings([]);
      setError(null);
      setAllTags([]);
      setTagIds([]);
      setOriginalTagIds([]);
      setTagError(null);
    }
  }, [open, documentId, fetchChunks, fetchTagsAndDoc]);

  const tagOptions = useMemo<MultiSelectOption[]>(
    () =>
      allTags.map((t) => ({
        value: t.id,
        label: t.name,
        description: t.description ?? t.slug,
      })),
    [allTags]
  );

  const tagsDirty = useMemo(() => {
    if (tagIds.length !== originalTagIds.length) return true;
    const sortedA = [...tagIds].sort();
    const sortedB = [...originalTagIds].sort();
    return sortedA.some((v, i) => v !== sortedB[i]);
  }, [tagIds, originalTagIds]);

  async function saveTags(): Promise<void> {
    if (!documentId) return;
    setTagSaving(true);
    setTagError(null);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId), {
        body: { tagIds },
      });
      setOriginalTagIds(tagIds);
    } catch (err) {
      setTagError(err instanceof APIClientError ? err.message : 'Failed to save tags');
    } finally {
      setTagSaving(false);
    }
  }

  const coverageHealthy = coverage !== null && coverage.coveragePct >= 95;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {documentName ?? 'Document'} — Chunks
          </DialogTitle>
          <DialogDescription>
            {chunks.length > 0
              ? `${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`
              : 'Loading...'}
          </DialogDescription>
        </DialogHeader>

        {/* Coverage summary — assures the operator that all source text
            made it into chunks. Green at ≥95%, amber below, with a help
            popover explaining how the metric is computed. */}
        {coverage !== null && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
              coverageHealthy
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
            }`}
          >
            {coverageHealthy ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div className="flex-1">
              <span className="font-medium">{coverage.coveragePct}% of source text captured</span>{' '}
              <span className="opacity-80">
                ({coverage.chunkChars.toLocaleString()} of {coverage.parsedChars.toLocaleString()}{' '}
                chars)
              </span>
              <FieldHelp
                title="Coverage metric"
                ariaLabel="About the coverage metric"
                contentClassName="w-80"
              >
                <p>
                  Compares the total length of all stored chunks against the parsed source text fed
                  into the chunker. A high value means everything we parsed made it into the
                  knowledge base.
                </p>
                <p className="mt-2">
                  <strong>Below 95%</strong> indicates the chunker dropped or trimmed content — most
                  commonly an oversize CSV row above the per-row embedding cap, or a paragraph split
                  that produced empty fragments.
                </p>
                <p className="mt-2">
                  Coverage can exceed 100%: heading-aware chunking re-emits section titles inside
                  each child chunk, so the sum of chunks is often slightly larger than the source.
                </p>
              </FieldHelp>
            </div>
          </div>
        )}

        {/* Document-level warnings (parser warnings + low-coverage notice). */}
        {warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              Ingestion warnings
            </div>
            <ul className="space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-300">
              {warnings.map((w, i) => (
                <li key={i} className="list-disc">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Tag editor — apply or remove knowledge tags. Tags determine which
            agents can search this doc (when an agent runs in restricted mode).
            See lib/orchestration/knowledge/resolveAgentDocumentAccess.ts. */}
        <div className="grid gap-2 rounded-md border p-3">
          <Label htmlFor="doc-tags" className="text-sm">
            Tags{' '}
            <FieldHelp title="Knowledge tags">
              <p>
                Apply one or more tags so agents running in <em>Restricted</em> knowledge mode can
                find this document. Manage the tag taxonomy under <em>Knowledge → Tags</em>.
              </p>
              <p className="mt-2">
                System-scoped documents are always visible regardless of tags — tagging them is
                still useful for filtering and organisation.
              </p>
            </FieldHelp>
          </Label>
          {allTags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No tags exist yet. Create some under <em>Knowledge → Tags</em>.
            </p>
          ) : (
            <>
              <MultiSelect
                id="doc-tags"
                value={tagIds}
                onChange={setTagIds}
                options={tagOptions}
                placeholder="No tags applied"
                emptyText="No matching tags."
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  {tagError ? (
                    <span className="text-destructive">{tagError}</span>
                  ) : tagsDirty ? (
                    'Unsaved tag changes.'
                  ) : (
                    'Tag changes take effect immediately for all agents.'
                  )}
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    void saveTags();
                  }}
                  disabled={!tagsDirty || tagSaving}
                >
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {tagSaving ? 'Saving…' : 'Save tags'}
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3">
          {loading && (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading chunks...</p>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}

          {!loading &&
            !error &&
            chunks.map((chunk, i) => (
              <div key={chunk.id} className="space-y-1.5 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs font-medium">#{i + 1}</span>
                    <Badge variant="outline" className="text-xs">
                      {chunk.chunkType.replace(/_/g, ' ')}
                    </Badge>
                    {chunk.category && (
                      <Badge variant="secondary" className="text-xs">
                        {chunk.category}
                      </Badge>
                    )}
                    {chunk.section && (
                      <span className="text-muted-foreground text-xs">{chunk.section}</span>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    ~{chunk.estimatedTokens} tokens
                  </span>
                </div>
                <pre className="bg-muted/50 max-h-40 overflow-y-auto rounded p-2 text-xs whitespace-pre-wrap">
                  {chunk.content}
                </pre>
                {chunk.keywords && (
                  <div className="flex flex-wrap gap-1">
                    {chunk.keywords.split(',').map((kw) => (
                      <Badge key={kw.trim()} variant="outline" className="text-[10px]">
                        {kw.trim()}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}

          {!loading && !error && chunks.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No chunks found for this document.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
