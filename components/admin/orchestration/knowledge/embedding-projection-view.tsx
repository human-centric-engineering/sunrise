'use client';

/**
 * EmbeddingProjectionView — 2D scatter plot of every chunk's embedding,
 * projected from 1,536-dim → 2D server-side via UMAP. The point of this
 * view (vs the structural KB → Document → Chunk graph) is that
 * neighbouring points = semantically similar text, so clusters tell
 * the operator what topics their knowledge base actually covers.
 *
 * Why this is its own file (vs another method on visualize-tab.tsx):
 * `visualize-tab.tsx` is already pushing 720 lines of force-graph wiring.
 * The scatter view shares almost nothing with it apart from the
 * surrounding shell, so co-locating would just inflate the file
 * without sharing logic.
 *
 * Server contract: projection happens at
 * `GET /api/v1/admin/orchestration/knowledge/embeddings` — the
 * endpoint streams pgvector rows, runs UMAP with a seeded PRNG (so
 * layouts are stable across refreshes), and returns `{x, y}` per
 * chunk plus a `stats` block we use for the empty / truncated states.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Loader2, Network } from 'lucide-react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { API } from '@/lib/api/endpoints';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

const projectionChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  documentName: z.string(),
  documentStatus: z.string(),
  chunkType: z.string(),
  patternName: z.string().nullable(),
  section: z.string().nullable(),
  estimatedTokens: z.number(),
  contentPreview: z.string(),
  embeddingModel: z.string().nullable(),
  embeddingProvider: z.string().nullable(),
  embeddedAt: z.union([z.string(), z.date()]).nullable(),
  x: z.number(),
  y: z.number(),
});

const projectionStatsSchema = z.object({
  totalEmbedded: z.number(),
  returned: z.number(),
  truncated: z.boolean(),
  droppedMalformed: z.number(),
  projectable: z.boolean(),
  maxChunks: z.number(),
  minUsefulPoints: z.number(),
});

const projectionResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      chunks: z.array(projectionChunkSchema),
      stats: projectionStatsSchema,
    })
    .optional(),
});

type ProjectionChunk = z.infer<typeof projectionChunkSchema>;
type ProjectionStats = z.infer<typeof projectionStatsSchema>;

/**
 * Categorical palette for colouring points by document. Twelve
 * colours is enough to keep the first dozen documents visually
 * distinguishable; documents past that wrap and reuse colours, which
 * is OK — it's a soft affordance, not a guarantee. The palette is
 * tuned to read on both light and dark backgrounds.
 */
const DOCUMENT_PALETTE = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#f97316', // orange
  '#14b8a6', // teal
  '#84cc16', // lime
  '#ef4444', // red
  '#3b82f6', // blue
  '#eab308', // yellow
];

function colourForIndex(i: number): string {
  return DOCUMENT_PALETTE[i % DOCUMENT_PALETTE.length] ?? '#94a3b8';
}

interface EmbeddingProjectionViewProps {
  scope?: string;
}

export function EmbeddingProjectionView({ scope }: EmbeddingProjectionViewProps): ReactElement {
  const [chunks, setChunks] = useState<ProjectionChunk[] | null>(null);
  const [stats, setStats] = useState<ProjectionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectionChunk | null>(null);

  const fetchProjection = useCallback(async () => {
    setLoading(true);
    setError(null);
    setChunks(null);
    try {
      const params = new URLSearchParams();
      if (scope) params.set('scope', scope);
      const url = params.toString()
        ? `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDINGS}?${params.toString()}`
        : API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDINGS;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        setError(`Failed to load embedding projection (HTTP ${res.status})`);
        return;
      }
      const parsed = projectionResponseSchema.parse(await res.json());
      if (parsed.success && parsed.data) {
        setChunks(parsed.data.chunks);
        setStats(parsed.data.stats);
      } else {
        setError('Server returned an unexpected response shape.');
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not load projection: ${err.message}`
          : 'Network error — could not reach the server.'
      );
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void fetchProjection();
  }, [fetchProjection]);

  // Group chunks by document so points from the same document share a
  // colour (and so the legend reads as a list of documents). Memoised
  // because the resulting series array drives the entire chart and we
  // don't want to recompute it on every parent render.
  const seriesByDocument = useMemo(() => {
    if (!chunks) return [];
    const byDoc = new Map<string, { name: string; points: ProjectionChunk[] }>();
    for (const chunk of chunks) {
      const existing = byDoc.get(chunk.documentId);
      if (existing) {
        existing.points.push(chunk);
      } else {
        byDoc.set(chunk.documentId, { name: chunk.documentName, points: [chunk] });
      }
    }
    return Array.from(byDoc.entries()).map(([documentId, { name, points }], i) => ({
      documentId,
      name,
      colour: colourForIndex(i),
      points,
    }));
  }, [chunks]);

  const chartOption = useMemo(() => {
    if (seriesByDocument.length === 0) return {};

    return {
      tooltip: {
        trigger: 'item' as const,
        formatter: (params: { data?: { value?: number[]; chunk?: ProjectionChunk } }) => {
          const chunk = params.data?.chunk;
          if (!chunk) return '';
          const name = chunk.patternName ?? chunk.section ?? chunk.chunkType;
          const embedding = chunk.embeddingProvider
            ? `${chunk.embeddingProvider}${chunk.embeddingModel ? ` · ${chunk.embeddingModel}` : ''}`
            : 'unknown provider';
          return `<div style="max-width:300px;font-size:12px">
            <div style="font-weight:600">${escapeHtml(name)}</div>
            <div style="color:#888;margin:2px 0">${escapeHtml(chunk.documentName)} · ${chunk.estimatedTokens} tok</div>
            <div style="color:#888;font-size:11px">${escapeHtml(embedding)}</div>
            <div style="margin-top:6px;font-size:11px;max-height:90px;overflow:hidden">
              ${escapeHtml(chunk.contentPreview).slice(0, 180)}…
            </div>
          </div>`;
        },
      },
      legend: {
        // Documents past 12 wrap; show the legend bottom-aligned and
        // let echarts handle overflow.
        data: seriesByDocument.map((s) => s.name),
        bottom: 4,
        type: 'scroll' as const,
        textStyle: { fontSize: 11 },
      },
      grid: { left: 24, right: 24, top: 16, bottom: 48, containLabel: true },
      xAxis: {
        type: 'value' as const,
        scale: true,
        axisLabel: { show: false },
        splitLine: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        scale: true,
        axisLabel: { show: false },
        splitLine: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      series: seriesByDocument.map((s) => ({
        name: s.name,
        type: 'scatter' as const,
        symbolSize: 8,
        itemStyle: { color: s.colour, opacity: 0.85 },
        emphasis: { itemStyle: { borderColor: '#facc15', borderWidth: 2 } },
        data: s.points.map((p) => ({ value: [p.x, p.y], chunk: p })),
      })),
    };
  }, [seriesByDocument]);

  const handleClick = useCallback((params: { data?: { chunk?: ProjectionChunk } }) => {
    const chunk = params.data?.chunk;
    if (chunk) setSelected(chunk);
  }, []);

  if (loading) {
    return (
      <div className="bg-muted/30 flex h-[500px] items-center justify-center rounded-lg border">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Computing UMAP projection…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <p className="text-destructive text-sm font-medium">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void fetchProjection()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!chunks || chunks.length === 0) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <Network className="mx-auto mb-3 h-10 w-10 opacity-40" />
        <p className="text-sm font-medium">No embedded chunks to project</p>
        <p className="mt-1 text-xs">
          Upload documents and generate embeddings to see them clustered by semantic similarity.
        </p>
      </div>
    );
  }

  if (stats && !stats.projectable) {
    // We have *some* points but fewer than the minimum useful for
    // UMAP. Render the points anyway so the user sees they're there,
    // but explain why the layout is essentially random.
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div>
            UMAP needs at least <strong>{stats.minUsefulPoints}</strong> embedded chunks to produce
            a meaningful 2D layout. With {stats.returned}{' '}
            {stats.returned === 1 ? 'chunk' : 'chunks'}, the points below are placed at the origin —
            upload more documents to see real semantic clusters.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stats?.truncated && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div>
            Showing a uniform sample of <strong>{stats.returned.toLocaleString()}</strong> chunks
            out of {stats.totalEmbedded.toLocaleString()} embedded. Past{' '}
            {stats.maxChunks.toLocaleString()} points the projection takes too long and the scatter
            plot is too dense to read.
          </div>
        </div>
      )}

      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {stats?.returned.toLocaleString()} points · {seriesByDocument.length}{' '}
          {seriesByDocument.length === 1 ? 'document' : 'documents'} · neighbouring points are
          semantically similar
        </span>
        <Button variant="ghost" size="sm" onClick={() => void fetchProjection()}>
          Recompute
        </Button>
      </div>

      <div className="h-[500px] rounded-lg border">
        <ReactECharts
          option={chartOption}
          style={{ height: '100%', width: '100%' }}
          onEvents={{ click: handleClick }}
          notMerge
        />
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected?.patternName ?? selected?.section ?? selected?.chunkType}
              <Badge variant="outline" className="text-xs">
                chunk
              </Badge>
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <Field label="Document" value={selected.documentName} />
              <Field label="Type" value={selected.chunkType.replace(/_/g, ' ')} />
              {selected.section && <Field label="Section" value={selected.section} />}
              <Field label="Tokens" value={selected.estimatedTokens.toLocaleString()} />
              <Field
                label="Embedding"
                value={
                  selected.embeddingProvider
                    ? `${selected.embeddingProvider}${selected.embeddingModel ? ` · ${selected.embeddingModel}` : ''}`
                    : 'unknown provider'
                }
              />
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs">Content preview</span>
                <pre className="bg-muted/50 max-h-60 overflow-y-auto rounded-md border p-3 text-xs leading-relaxed whitespace-pre-wrap">
                  {selected.contentPreview}
                </pre>
              </div>
              <div className="flex justify-end pt-2">
                <DialogClose asChild>
                  <Button variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

/**
 * Tooltip strings are interpolated as raw HTML by ECharts (no React
 * involvement), so we have to escape user-influenced text — chunk
 * names, document names, content previews — to keep an injected `<` or
 * `&` from breaking the tooltip layout. Cheap and bidirectional safe.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
