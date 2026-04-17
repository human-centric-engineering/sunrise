'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { API } from '@/lib/api/endpoints';
import type { GraphData, GraphNode } from '@/types/orchestration';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/** Node type colours */
const CATEGORY_COLOURS = [
  '#6366f1', // KB — indigo
  '#22c55e', // Document (Ready) — green
  '#f59e0b', // Document (Pending) — amber
  '#ef4444', // Document (Failed) — red
  '#94a3b8', // Chunk — slate
];

interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

interface VisualizeTabProps {
  scope?: string;
}

export function VisualizeTab({ scope }: VisualizeTabProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const [view, setView] = useState<'structure' | 'embedded'>('structure');

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setGraphData(null);
    try {
      const params = new URLSearchParams({ view });
      if (scope) params.set('scope', scope);
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_GRAPH}?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as ApiResponse<GraphData>;
      if (body.success && body.data) {
        setGraphData(body.data);
      }
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, [scope, view]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  // Build ECharts option
  const chartOption = useMemo(() => {
    if (!graphData) return {};

    const lowerFilter = filterText.toLowerCase();
    const hasFilter = lowerFilter.length > 0;

    const nodes = graphData.nodes.map((node) => {
      const matches = !hasFilter || node.name.toLowerCase().includes(lowerFilter);
      return {
        id: node.id,
        name: node.name,
        symbolSize: node.value,
        category: node.category,
        itemStyle: {
          opacity: hasFilter && !matches ? 0.1 : 1,
          borderWidth: hasFilter && matches ? 3 : 1,
          borderColor: hasFilter && matches ? '#fff' : undefined,
        },
        label: {
          show: node.type !== 'chunk',
          fontSize: node.type === 'kb' ? 14 : 10,
          opacity: hasFilter && !matches ? 0.1 : 1,
        },
        // Store full node data for click handler
        value: node,
      };
    });

    const links = graphData.links.map((link) => ({
      source: link.source,
      target: link.target,
      lineStyle: { opacity: 0.3, width: 1 },
    }));

    const categories = graphData.categories.map((cat, i) => ({
      name: cat.name,
      itemStyle: { color: CATEGORY_COLOURS[i] ?? '#94a3b8' },
    }));

    return {
      tooltip: {
        trigger: 'item' as const,
        formatter: (params: { data?: { value?: GraphNode; name?: string } }) => {
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
          return `<div style="max-width:300px">
            <strong>${str('patternName') || node.name}</strong><br/>
            Type: ${str('chunkType')}<br/>
            ${meta.section ? `Section: ${str('section')}<br/>` : ''}
            Tokens: ${num('estimatedTokens')}<br/>
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
            lineStyle: { width: 3 },
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
  }, [graphData, filterText]);

  const handleChartClick = useCallback((params: { data?: { value?: GraphNode } }) => {
    const node = params.data?.value;
    if (node) setSelectedNode(node);
  }, []);

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

  if (!graphData || graphData.stats.documentCount === 0) {
    const scopeLabel = scope === 'system' ? 'system' : scope === 'app' ? 'app-specific' : '';
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <Network className="mx-auto mb-3 h-10 w-10 opacity-40" />
        <p className="text-sm font-medium">No {scopeLabel} knowledge base data</p>
        <p className="mt-1 text-xs">
          {scope === 'app'
            ? 'Upload app-specific documents to see them here.'
            : 'Upload documents and generate embeddings to visualize the knowledge graph.'}
        </p>
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

      {/* Chart */}
      <div className={fullscreen ? 'flex-1' : 'h-[500px]'}>
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

      {/* View toggle: Structure / Embedded */}
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
        </div>
        {view === 'embedded' && (
          <span className="text-muted-foreground text-xs">
            Showing only chunks with vector embeddings
          </span>
        )}
      </div>

      {graphContent}

      {/* Node detail dialog */}
      <Dialog open={selectedNode !== null} onOpenChange={(open) => !open && setSelectedNode(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedNode?.name}
              <Badge variant="outline" className="text-xs">
                {selectedNode?.type}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          {selectedNode?.metadata && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(selectedNode.metadata).map(([key, value]) => (
                  <div key={key} className="col-span-2 grid grid-cols-2 gap-2">
                    <span className="text-muted-foreground capitalize">
                      {key.replace(/([A-Z])/g, ' $1').trim()}
                    </span>
                    <span className="text-xs break-all">
                      {typeof value === 'string'
                        ? value.length > 300
                          ? `${value.slice(0, 300)}...`
                          : value
                        : typeof value === 'number'
                          ? value.toLocaleString()
                          : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
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
