'use client';

/**
 * Inspect and (optionally) enrich the BM25 keywords on a document.
 *
 * Opens from the "BM25 keywords" column on the documents table. Fetches
 * the document's chunks (reusing the existing chunks endpoint, which
 * already returns each chunk's `keywords` field), aggregates the
 * comma-separated values into a distinct list with per-keyword chunk
 * counts, and lets the operator fire the post-upload "Enrich keywords"
 * action without leaving the document list.
 *
 * Why client-side aggregation: the chunks endpoint is already paginated
 * and returns the data we need. Adding a server-side `/keywords` view
 * would duplicate work for ≤500 chunks per doc (the enricher cap).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Tag as TagIcon } from 'lucide-react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
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
import { API } from '@/lib/api/endpoints';

const chunksResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      chunks: z.array(
        z.object({
          id: z.string(),
          keywords: z.string().nullable(),
        })
      ),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

const enrichResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      chunksProcessed: z.number().optional(),
      chunksFailed: z.number().optional(),
      chunksSkipped: z.number().optional(),
      costUsd: z.number().optional(),
      model: z.string().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

interface KeywordRow {
  keyword: string;
  chunkCount: number;
}

export interface DocumentKeywordsModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful enrich so the parent can refresh its list. */
  onEnriched?: () => void;
}

export function DocumentKeywordsModal({
  documentId,
  documentName,
  open,
  onOpenChange,
  onEnriched,
}: DocumentKeywordsModalProps): React.ReactElement {
  const [rows, setRows] = useState<KeywordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [confirmEnrich, setConfirmEnrich] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<string | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  const fetchKeywords = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentChunks(documentId));
      if (!res.ok) throw new Error(`Failed to load keywords (${res.status})`);
      const body = chunksResponseSchema.parse(await res.json());
      const chunks = body.data?.chunks ?? [];

      // Aggregate: for each chunk, split `keywords` on comma, trim, lower,
      // and tally distinct values with their per-chunk counts. A keyword
      // that appears twice in the same chunk only counts once for that
      // chunk — what matters is "how many chunks does BM25 see this
      // term on?", not the raw token count.
      const tally = new Map<string, number>();
      for (const chunk of chunks) {
        if (!chunk.keywords) continue;
        const seenInChunk = new Set<string>();
        for (const raw of chunk.keywords.split(',')) {
          const kw = raw.trim().toLowerCase();
          if (kw.length === 0 || seenInChunk.has(kw)) continue;
          seenInChunk.add(kw);
          tally.set(kw, (tally.get(kw) ?? 0) + 1);
        }
      }
      const list: KeywordRow[] = Array.from(tally.entries())
        .map(([keyword, chunkCount]) => ({ keyword, chunkCount }))
        .sort((a, b) =>
          b.chunkCount !== a.chunkCount
            ? b.chunkCount - a.chunkCount
            : a.keyword.localeCompare(b.keyword)
        );
      setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keywords');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    if (open && documentId) {
      void fetchKeywords();
    }
    if (!open) {
      setRows([]);
      setError(null);
      setFilter('');
      setConfirmEnrich(false);
      setEnrichResult(null);
      setEnrichError(null);
    }
  }, [open, documentId, fetchKeywords]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.keyword.includes(q));
  }, [rows, filter]);

  const handleEnrich = useCallback(async () => {
    if (!documentId) return;
    setEnriching(true);
    setEnrichError(null);
    setEnrichResult(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentEnrichKeywords(documentId), {
        method: 'POST',
      });
      const body = enrichResponseSchema.parse(await res.json().catch(() => ({})));
      if (!res.ok || !body.success) {
        setEnrichError(body.error?.message ?? `Enrich failed (${res.status})`);
        return;
      }
      const processed = body.data?.chunksProcessed ?? 0;
      const failed = body.data?.chunksFailed ?? 0;
      const cost = body.data?.costUsd ?? 0;
      const parts = [`Enriched ${processed} chunk${processed === 1 ? '' : 's'}`];
      if (failed > 0) parts.push(`${failed} failed`);
      parts.push(`~$${cost.toFixed(4)}`);
      setEnrichResult(parts.join(' · '));
      // Refresh in-place so the operator sees the new keyword list.
      await fetchKeywords();
      onEnriched?.();
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : 'Enrich failed');
    } finally {
      setEnriching(false);
      setConfirmEnrich(false);
    }
  }, [documentId, fetchKeywords, onEnriched]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="h-5 w-5" />
            BM25 keywords — {documentName ?? 'Document'}
          </DialogTitle>
          <DialogDescription>
            Distinct keywords currently indexed across this document&apos;s chunks. These feed the
            BM25 component of hybrid search — chunks whose keywords match the query get a relevance
            boost. Keywords affect <em>how</em> a chunk ranks, never <em>who</em> can see it (that
            is what tags are for).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter keywords…"
              aria-label="Filter keywords"
              className="border-input bg-background h-8 flex-1 rounded-md border px-3 text-sm"
            />
            <FieldHelp title="How keywords are created" contentClassName="w-96">
              <p>
                Two sources today:
                <br />
                1.{' '}
                <strong>
                  <code className="text-[10px]">{'<!-- metadata: keywords="..." -->'}</code>
                </strong>{' '}
                comments inside markdown uploads — the chunker reads them and writes the
                comma-separated value onto each chunk in scope.
                <br />
                2. The <strong>Enrich keywords</strong> action below — runs an LLM over every chunk
                and writes 3–8 phrases. Use this when an upload doesn&apos;t rank for queries whose
                vocabulary differs from the content.
              </p>
              <p className="mt-2 text-xs">
                Empty is fine. BM25 still indexes chunk content; keywords are a precision dial, not
                the primary lexical signal.
              </p>
            </FieldHelp>
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          {enrichError ? <p className="text-destructive text-sm">{enrichError}</p> : null}
          {enrichResult ? <p className="text-sm text-emerald-600">{enrichResult}</p> : null}

          {loading ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center">
              <p className="text-sm">No keywords indexed yet.</p>
              <p className="mt-1 text-xs">
                Run <strong>Enrich keywords</strong> below to generate 3–8 BM25 phrases per chunk
                using the configured chat model.
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <div className="text-muted-foreground bg-muted/40 flex items-center justify-between border-b px-3 py-1.5 text-xs">
                <span>
                  {filtered.length} of {rows.length} keyword{rows.length === 1 ? '' : 's'}
                </span>
                <span>chunks</span>
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                    No keywords match &ldquo;{filter}&rdquo;.
                  </p>
                ) : (
                  filtered.map((row) => (
                    <div
                      key={row.keyword}
                      className="hover:bg-muted/40 flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                    >
                      <span className="truncate">{row.keyword}</span>
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {row.chunkCount}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          {confirmEnrich ? (
            <span className="flex flex-1 items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Overwrite keywords on every chunk?
              </span>
              <span className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmEnrich(false)}
                  disabled={enriching}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void handleEnrich()} disabled={enriching}>
                  {enriching ? 'Enriching…' : 'Yes, overwrite'}
                </Button>
              </span>
            </span>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => setConfirmEnrich(true)} disabled={enriching}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {rows.length === 0 ? 'Enrich keywords' : 'Re-enrich keywords'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
