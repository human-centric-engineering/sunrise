'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileText, Hash, Maximize2, Minimize2, Network, Search, X, Puzzle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';
import { EmbeddingProjectionView } from '@/components/admin/orchestration/knowledge/embedding-projection-view';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/** Node type colours */
const CATEGORY_COLOURS = [
  '#6366f1', // KB — indigo
  '#22c55e', // Document (Ready) — green
  '#f59e0b', // Document (Pending) — amber
  '#ef4444', // Document (Failed) — red
  '#94a3b8', // Chunk — slate
];

const graphNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['kb', 'document', 'chunk']),
  value: z.number(),
  status: z.string().optional(),
  category: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const graphDataSchema = z.object({
  nodes: z.array(graphNodeSchema),
  links: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      label: z.string().optional(),
    })
  ),
  categories: z.array(z.object({ name: z.string() })),
  stats: z.object({
    documentCount: z.number(),
    completedCount: z.number(),
    chunkCount: z.number(),
    totalTokens: z.number(),
  }),
});

type GraphData = z.infer<typeof graphDataSchema>;
type GraphNode = z.infer<typeof graphNodeSchema>;

const graphResponseSchema = z.object({
  success: z.boolean(),
  data: graphDataSchema.optional(),
});

interface VisualizeTabProps {
  scope?: string;
}

export function VisualizeTab({ scope }: VisualizeTabProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const [view, setView] = useState<'structure' | 'embedded' | 'embedding-space'>('structure');

  const [graphError, setGraphError] = useState<string | null>(null);

  // ECharts force layout uses pixel coordinates with origin at the
  // top-left of the chart series rect (confirmed against ECharts' own
  // force-graph examples — node x/y are pixel values like 300, 280).
  // To anchor the KB hub at the visual centre we must know the chart's
  // actual pixel dimensions; we observe the chart container with a
  // ResizeObserver and feed the measured size into the chartOption.
  // The fallback (800×500) avoids a first-render flash at (0, 0)
  // before the observer fires.
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState<{ width: number; height: number }>({
    width: 800,
    height: 500,
  });
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      // Only update if the change is meaningful — a 1-px jitter from a
      // scrollbar appearing shouldn't trigger a force-layout restart.
      setChartSize((prev) =>
        Math.abs(prev.width - width) > 4 || Math.abs(prev.height - height) > 4
          ? { width, height }
          : prev
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fetchGraph = useCallback(async () => {
    // The embedding-space view fetches its own data via
    // EmbeddingProjectionView; no need to hit /knowledge/graph for it.
    if (view === 'embedding-space') {
      setLoading(false);
      setGraphData(null);
      setGraphError(null);
      return;
    }
    setLoading(true);
    setGraphData(null);
    setSelectedNode(null);
    setGraphError(null);
    try {
      const params = new URLSearchParams({ view });
      if (scope) params.set('scope', scope);
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_GRAPH}?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setGraphError(`Failed to load graph (${res.status})`);
        return;
      }
      const body = graphResponseSchema.parse(await res.json());
      if (body.success && body.data) {
        setGraphData(body.data);
      }
    } catch {
      setGraphError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [scope, view]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  // Toggle is reused in two places — the embedding-space early-return
  // (which bypasses the graph fetch entirely) and the main render path
  // below the graph chart. Defining it here keeps the two surfaces in
  // lockstep so a future change can't accidentally diverge them.
  const viewToggle = (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground text-xs font-medium">View</span>
      <div className="bg-muted inline-flex items-center rounded-lg p-1">
        <button
          type="button"
          onClick={() => setView('structure')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            view === 'structure'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Structure
        </button>
        <button
          type="button"
          onClick={() => setView('embedded')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            view === 'embedded'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Embedded
        </button>
        <button
          type="button"
          onClick={() => setView('embedding-space')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            view === 'embedding-space'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Embedding space
        </button>
      </div>
      {/* Per-view explainer — content swaps with the active view so the
          user always sees a description of what they're currently looking
          at. The toggle row caption stays terse; depth lives in the
          FieldHelp popover. */}
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        {view === 'structure' && (
          <>
            Every document and chunk in the knowledge base
            <FieldHelp
              title="Structure view"
              ariaLabel="About the Structure view"
              contentClassName="w-96"
            >
              <p>
                Shows <strong>every document and every chunk</strong> regardless of embedding
                status. This is the full topology of what&apos;s stored — including documents that
                are still being processed (amber) or failed to embed (red).
              </p>
              <p className="mt-2">
                Use this view to audit ingestion: a chunk visible here but missing from{' '}
                <strong>Embedded</strong> has been split out of the source document but doesn&apos;t
                yet have a vector, so an agent can&apos;t retrieve it via semantic search.
              </p>
              <p className="mt-2 text-xs">
                Past 500 chunks, individual chunk nodes are hidden for performance and only
                document-level nodes are drawn.
              </p>
            </FieldHelp>
          </>
        )}
        {view === 'embedded' && (
          <>
            Only chunks that have vector embeddings
            <FieldHelp
              title="Embedded view"
              ariaLabel="About the Embedded view"
              contentClassName="w-96"
            >
              <p>
                Filters to chunks where the <strong>embedding vector has been computed</strong> and
                stored. Documents with zero embedded chunks are hidden entirely.
              </p>
              <p className="mt-2">
                This is what&apos;s <strong>actually searchable</strong> by your agents — every
                chunk shown here can be retrieved via vector similarity. If a document appears in
                Structure but not Embedded, it&apos;s been chunked but the embedding step
                hasn&apos;t completed (or it failed).
              </p>
              <p className="mt-2 text-xs">
                If this view looks identical to Structure, your knowledge base is fully embedded —
                that&apos;s the healthy state.
              </p>
            </FieldHelp>
          </>
        )}
        {view === 'embedding-space' && (
          <>
            UMAP-projected chunks — clusters = semantic similarity
            <FieldHelp
              title="Embedding space view"
              ariaLabel="About the Embedding space view"
              contentClassName="w-96"
            >
              <p>
                A different view of the same chunks: each one becomes a single{' '}
                <strong>2D point</strong> on a scatter plot. The (x, y) position is derived from the
                chunk&apos;s 1,536-dim embedding vector via <strong>UMAP</strong> — a
                dimensionality-reduction algorithm that preserves local neighbour structure.
              </p>
              <p className="mt-2">
                <strong>Neighbouring points are semantically similar.</strong> Visible clusters tell
                you what topics your knowledge base actually covers; outliers are chunks that
                don&apos;t fit any cluster. Points are coloured by source document, so you can see
                whether documents talk about overlapping or disjoint topics.
              </p>
              <p className="mt-2 text-xs">
                UMAP needs at least 10 embedded chunks to produce a meaningful layout. Past 2,000
                points the view samples uniformly to keep the projection fast and the plot readable.
                Hover for chunk metadata, click for the full preview.
              </p>
            </FieldHelp>
          </>
        )}
      </span>
    </div>
  );

  // Build ECharts option
  const chartOption = useMemo(() => {
    if (!graphData) return {};

    const lowerFilter = filterText.toLowerCase();
    const hasFilter = lowerFilter.length > 0;

    const nodeMatches = (node: GraphNode): boolean => {
      if (!hasFilter) return true;
      // Search across name and key metadata fields
      const searchable = [
        node.name,
        ...(node.metadata
          ? [
              node.metadata.fileName,
              node.metadata.patternName,
              node.metadata.chunkType,
              node.metadata.section,
              node.metadata.category,
              node.metadata.status,
              node.metadata.contentPreview,
            ]
          : []),
      ];
      return searchable.some((v) => typeof v === 'string' && v.toLowerCase().includes(lowerFilter));
    };

    // Anchor the KB hub at the chart's pixel centre and seed each
    // document on a ring around it.
    //
    // ECharts graph force layout operates in pixel coordinates with
    // the origin at the chart series rect's top-left — there is no
    // data-space auto-centre (verified against ECharts' own
    // force-graph examples, where nodes carry pixel x/y like 300/280).
    // A previous attempt pinned the KB at (0, 0) hoping the view box
    // would auto-fit and centre on data; it doesn't, so the KB ended
    // up parked at the top-left of the canvas.
    //
    // Fix: read the actual chart pixel dimensions via a ResizeObserver
    // on the surrounding container, then pin the KB at (width/2,
    // height/2) and seed documents on a ring whose radius is sized to
    // the smaller axis so the ring fits comfortably regardless of
    // aspect ratio. Chunks remain unseeded — ECharts randomises them
    // and force repulsion from their parent document distributes them
    // outward naturally.
    const centreX = chartSize.width / 2;
    const centreY = chartSize.height / 2;
    const docRingRadius = Math.max(60, Math.min(chartSize.width, chartSize.height) * 0.3);

    const documentNodes = graphData.nodes.filter((n) => n.type === 'document');
    const docCount = Math.max(documentNodes.length, 1);
    const docInitialPositions = new Map<string, { x: number; y: number }>(
      documentNodes.map((d, i) => {
        const angle = (i / docCount) * 2 * Math.PI - Math.PI / 2; // start at top
        return [
          d.id,
          {
            x: centreX + docRingRadius * Math.cos(angle),
            y: centreY + docRingRadius * Math.sin(angle),
          },
        ];
      })
    );

    const nodes = graphData.nodes.map((node) => {
      const matches = nodeMatches(node);
      const isKb = node.type === 'kb';
      const seedPos = isKb
        ? { x: centreX, y: centreY, fixed: true as const }
        : (docInitialPositions.get(node.id) ?? {});
      return {
        id: node.id,
        name: node.name,
        symbolSize: node.value,
        category: node.category,
        ...seedPos,
        itemStyle: {
          opacity: hasFilter && !matches ? 0.1 : 1,
          borderWidth: hasFilter && matches ? 3 : 1,
          borderColor: hasFilter && matches ? '#fff' : undefined,
        },
        label: {
          show: node.type !== 'chunk',
          fontSize: isKb ? 14 : 10,
          opacity: hasFilter && !matches ? 0.1 : 1,
        },
        // Store full node data for click handler
        value: node,
      };
    });

    // Build a lookup so edge tooltips can reference node data
    const nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));

    const links = graphData.links.map((link) => {
      const sourceNode = nodeById.get(link.source);
      const targetNode = nodeById.get(link.target);
      return {
        source: link.source,
        target: link.target,
        lineStyle: { opacity: 0.3, width: 1 },
        label: {
          show: false,
          formatter: link.label ?? '',
          fontSize: 10,
          color: '#94a3b8',
        },
        emphasis: {
          label: { show: true, fontSize: 11, color: '#e2e8f0' },
          lineStyle: { width: 2, opacity: 0.85 },
        },
        // Stash for the edge tooltip
        edgeMeta: {
          label: link.label,
          sourceName: sourceNode?.name ?? link.source,
          sourceType: sourceNode?.type ?? 'unknown',
          sourceMeta: sourceNode?.metadata,
          targetName: targetNode?.name ?? link.target,
          targetType: targetNode?.type ?? 'unknown',
          targetMeta: targetNode?.metadata,
        },
      };
    });

    const categories = graphData.categories.map((cat, i) => ({
      name: cat.name,
      itemStyle: { color: CATEGORY_COLOURS[i] ?? '#94a3b8' },
    }));

    return {
      tooltip: {
        trigger: 'item' as const,
        // Constrain tooltip width and force wrapping on the outer container —
        // inner div max-widths don't help when a single long token (URL,
        // hyphenless file name, long chunk preview) has no break opportunity.
        extraCssText:
          'max-width:320px;white-space:normal;word-break:break-word;overflow-wrap:anywhere;',
        formatter: (params: {
          dataType?: string;
          data?: {
            value?: GraphNode;
            name?: string;
            edgeMeta?: {
              label?: string;
              sourceName: string;
              sourceType: string;
              sourceMeta?: Record<string, unknown>;
              targetName: string;
              targetType: string;
              targetMeta?: Record<string, unknown>;
            };
          };
        }) => {
          // --- Edge tooltip ---
          if (params.dataType === 'edge') {
            const em = params.data?.edgeMeta;
            if (!em) return '';

            const nodeLine = (
              name: string,
              type: string,
              meta?: Record<string, unknown>
            ): string => {
              const m = meta ?? {};
              const num = (k: string) => (typeof m[k] === 'number' ? m[k] : 0);
              const str = (k: string) => (typeof m[k] === 'string' ? m[k] : '');
              if (type === 'kb') return 'Knowledge Base';
              if (type === 'document') {
                const detail = `${num('chunkCount')} chunks`;
                return `${name}<br/><span style="color:#888;font-size:11px">${detail}</span>`;
              }
              const label = str('patternName') || name;
              const tokens = num('estimatedTokens');
              const provider = str('embeddingProvider');
              const detail =
                str('chunkType').replace(/_/g, ' ') +
                (tokens ? ` · ${tokens} tok` : '') +
                (provider ? ` · ${provider}` : '');
              return `${label}<br/><span style="color:#888;font-size:11px">${detail}</span>`;
            };

            return `<div style="max-width:260px;font-size:12px">
              <div>${nodeLine(em.sourceName, em.sourceType, em.sourceMeta)}</div>
              <div style="text-align:center;color:#facc15;font-size:11px;padding:2px 0">↓ ${em.label ?? ''}</div>
              <div>${nodeLine(em.targetName, em.targetType, em.targetMeta)}</div>
            </div>`;
          }

          // --- Node tooltip ---
          const node = params.data?.value;
          if (!node?.metadata) return params.data?.name ?? '';

          const meta = node.metadata;
          const str = (key: string, fallback = ''): string =>
            typeof meta[key] === 'string'
              ? meta[key]
              : typeof meta[key] === 'number'
                ? String(meta[key])
                : fallback;
          const num = (key: string): number => (typeof meta[key] === 'number' ? meta[key] : 0);

          if (node.type === 'kb') {
            return `<div style="max-width:250px">
              <strong>Knowledge Base</strong><br/>
              Documents: ${num('documents')}<br/>
              Chunks: ${num('chunks')}<br/>
              Total tokens: ${num('totalTokens').toLocaleString()}
            </div>`;
          }

          if (node.type === 'document') {
            return `<div style="max-width:280px">
              <strong>${node.name}</strong><br/>
              Status: ${str('status', 'unknown')}<br/>
              Chunks: ${num('chunkCount')}<br/>
              Tokens: ${num('totalTokens').toLocaleString()}<br/>
              ${meta.errorMessage ? `<span style="color:#ef4444">Error: ${str('errorMessage').slice(0, 120)}</span>` : ''}
            </div>`;
          }

          // Chunk
          const embeddingInfo = str('embeddingProvider')
            ? `${str('embeddingProvider')} · ${str('embeddingModel')}${meta.embeddedAt ? ` · ${new Date(meta.embeddedAt as string).toLocaleDateString()}` : ''}`
            : 'not embedded';
          return `<div style="max-width:300px">
            <strong>${str('patternName') || node.name}</strong><br/>
            Type: ${str('chunkType')}<br/>
            ${meta.section ? `Section: ${str('section')}<br/>` : ''}
            Tokens: ${num('estimatedTokens')}<br/>
            Embedding: ${embeddingInfo}<br/>
            <div style="margin-top:4px;font-size:11px;color:#888;max-height:80px;overflow:hidden">
              ${str('contentPreview').slice(0, 150)}...
            </div>
          </div>`;
        },
      },
      legend: {
        data: graphData.categories.map((c) => c.name),
        orient: 'horizontal' as const,
        bottom: 10,
        textStyle: { fontSize: 11 },
      },
      animationDuration: 500,
      animationEasingUpdate: 'quinticInOut' as const,
      series: [
        {
          type: 'graph',
          layout: 'force',
          data: nodes,
          links,
          categories,
          roam: true,
          draggable: true,
          force: {
            repulsion: 200,
            gravity: 0.08,
            edgeLength: [40, 200],
            friction: 0.6,
          },
          emphasis: {
            focus: 'adjacency' as const,
            itemStyle: {
              borderWidth: 2,
              borderColor: '#facc15',
              shadowBlur: 6,
              shadowColor: 'rgba(250, 204, 21, 0.3)',
            },
            lineStyle: { width: 2, opacity: 0.8, color: '#facc15' },
            label: { show: true, fontSize: 12 },
          },
          blur: {
            itemStyle: { opacity: 0.15 },
            lineStyle: { opacity: 0.1 },
            label: { opacity: 0.15 },
          },
          lineStyle: {
            color: 'source',
            curveness: 0.1,
          },
          label: {
            position: 'right' as const,
            formatter: '{b}',
          },
        },
      ],
    };
  }, [graphData, filterText, chartSize]);

  const handleChartClick = useCallback((params: { data?: { value?: GraphNode } }) => {
    const node = params.data?.value;
    if (node) setSelectedNode(node);
  }, []);

  // Embedding-space view bypasses the structural graph entirely — it
  // has its own data source (/knowledge/embeddings) and its own
  // loading/error/empty handling, so we short-circuit before the graph
  // chrome (stats cards, search, fullscreen) which doesn't apply.
  // This early return must come AFTER all hook calls — React requires
  // hooks be invoked in the same order on every render.
  if (view === 'embedding-space') {
    return (
      <div className="space-y-4">
        {viewToggle}
        <EmbeddingProjectionView scope={scope} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-muted/30 h-20 animate-pulse rounded-lg border" />
          ))}
        </div>
        <div className="bg-muted/30 h-96 animate-pulse rounded-lg border" />
      </div>
    );
  }

  if (graphError) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <p className="text-destructive text-sm font-medium">{graphError}</p>
      </div>
    );
  }

  if (!graphData || graphData.stats.documentCount === 0) {
    const scopeLabel = scope === 'system' ? 'system' : scope === 'app' ? 'app-specific' : '';
    // When the embedded view is empty but structure has data, the
    // toggle lets the user jump back. Showing the full three-button
    // toggle here keeps the UI consistent — including offering the
    // Embedding-space view, which has its own data path and may have
    // results even when the structural graph looks empty.
    const showToggle = view === 'embedded' && graphData !== null;
    return (
      <div className="space-y-4">
        {showToggle && viewToggle}
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          <Network className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm font-medium">
            {showToggle ? 'No embedded chunks yet' : `No ${scopeLabel} knowledge base data`}
          </p>
          <p className="mt-1 text-xs">
            {showToggle
              ? 'Generate embeddings to see chunks in this view, or switch to Structure.'
              : scope === 'app'
                ? 'Upload app-specific documents to see them here.'
                : 'Upload documents and generate embeddings to visualize the knowledge graph.'}
          </p>
        </div>
      </div>
    );
  }

  const { stats } = graphData;

  const graphContent = (
    <div className={fullscreen ? 'bg-background fixed inset-0 z-50 flex flex-col' : ''}>
      {/* Fullscreen header */}
      {fullscreen && (
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-medium">Knowledge Graph</span>
          <Button variant="ghost" size="sm" onClick={() => setFullscreen(false)}>
            <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
            Exit Fullscreen
          </Button>
        </div>
      )}

      {/* Search + fullscreen toggle (non-fullscreen) */}
      {!fullscreen && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Filter nodes..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="pr-10 pl-10"
            />
            {filterText && (
              <button
                type="button"
                onClick={() => setFilterText('')}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setFullscreen(true)}>
            <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
            Fullscreen
          </Button>
        </div>
      )}

      {/* Fullscreen search bar */}
      {fullscreen && (
        <div className="border-b px-4 py-2">
          <div className="relative max-w-sm">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Filter nodes..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
      )}

      {/* Chart — ref drives the ResizeObserver feeding chartSize, which
          in turn positions the KB hub at the chart's pixel centre. */}
      <div ref={chartContainerRef} className={fullscreen ? 'flex-1' : 'h-[500px]'}>
        <ReactECharts
          option={chartOption}
          style={{ height: '100%', width: '100%' }}
          onEvents={{ click: handleChartClick }}
          notMerge
        />
      </div>

      {/* Aggregation note */}
      {graphData.stats.chunkCount > 500 && (
        <p className="text-muted-foreground px-1 py-2 text-center text-xs">
          Showing document-level view. Individual chunk nodes hidden for performance (
          {graphData.stats.chunkCount} chunks).
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <FileText className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.documentCount}</p>
              <p className="text-muted-foreground text-xs">Documents</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <span className="text-sm font-bold text-green-700 dark:text-green-400">
                {stats.completedCount}
              </span>
            </div>
            <div>
              <p className="text-2xl font-bold">
                {stats.documentCount > 0
                  ? Math.round((stats.completedCount / stats.documentCount) * 100)
                  : 0}
                %
              </p>
              <p className="text-muted-foreground text-xs">Completed</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <Puzzle className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.chunkCount}</p>
              <p className="text-muted-foreground text-xs">Chunks</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <Hash className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.totalTokens.toLocaleString()}</p>
              <p className="text-muted-foreground text-xs">Total Tokens</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Knowledge graph overview — covers the general "what is this and
          how do I interact with it" question. Per-view depth lives in the
          FieldHelp on the toggle row below, so a user can drill into the
          specific view they're looking at without re-reading shared
          intro material. */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          Knowledge Graph{' '}
          <FieldHelp
            title="Knowledge Graph"
            ariaLabel="About the knowledge graph"
            contentClassName="w-96"
          >
            <p>
              A <strong>knowledge graph</strong> is a visual map of how your knowledge base is
              structured. Each circle is a <strong>node</strong> (the Knowledge Base hub, a
              document, or a chunk) and the lines between them are <strong>edges</strong> that
              describe relationships — e.g. &quot;contains (12 chunks)&quot; or &quot;section:
              Implementation&quot;.
            </p>
            <p className="mt-2">
              <strong>Node colours:</strong> indigo = Knowledge Base, green/amber/red =
              ready/pending/failed documents, slate = chunks.
            </p>
            <p className="text-foreground mt-2 font-medium">Interaction</p>
            <p>
              <strong>Hover</strong> a node to highlight its neighbours; hover an edge to see both
              endpoints. <strong>Click</strong> for a detail panel. <strong>Drag</strong> nodes to
              rearrange, <strong>scroll</strong> to zoom.
            </p>
            <p className="mt-2 text-xs">
              Use the <strong>View</strong> toggle below to switch between Structure, Embedded, and
              Embedding space. The ⓘ next to each toggle explains what that view shows.
            </p>
          </FieldHelp>
        </span>
      </div>

      {/* View toggle: Structure / Embedded / Embedding space */}
      {viewToggle}

      {graphContent}

      {/* Node detail dialog */}
      <Dialog open={selectedNode !== null} onOpenChange={(open) => !open && setSelectedNode(null)}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedNode?.name}
              <Badge variant="outline" className="text-xs">
                {selectedNode?.type}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          {selectedNode?.metadata && (
            <div className="space-y-3">
              {/* Metadata grid — exclude contentPreview (rendered separately) */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(selectedNode.metadata)
                  .filter(([key]) => key !== 'contentPreview')
                  .map(([key, value]) => (
                    <div key={key} className="col-span-2 grid grid-cols-2 gap-2">
                      <span className="text-muted-foreground capitalize">
                        {key.replace(/([A-Z])/g, ' $1').trim()}
                      </span>
                      <span className="text-xs break-all">
                        {typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
                          ? new Date(value).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : typeof value === 'string'
                            ? value
                            : typeof value === 'number'
                              ? value.toLocaleString()
                              : JSON.stringify(value)}
                      </span>
                    </div>
                  ))}
              </div>

              {/* Content preview — rendered as scrollable formatted block */}
              {typeof selectedNode.metadata.contentPreview === 'string' && (
                <div className="space-y-1.5">
                  <span className="text-muted-foreground text-sm capitalize">Content preview</span>
                  <pre className="bg-muted/50 max-h-60 overflow-y-auto rounded-md border p-3 text-xs leading-relaxed whitespace-pre-wrap">
                    {selectedNode.metadata.contentPreview}
                  </pre>
                </div>
              )}

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
