'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpDown, Check, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { API } from '@/lib/api/endpoints';
import type { EmbeddingModelInfo } from '@/lib/orchestration/llm/embedding-models';

interface CompareProvidersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SortField = 'provider' | 'cost' | 'quality' | 'dimensions';
type SortDir = 'asc' | 'desc';

const QUALITY_ORDER: Record<string, number> = { high: 3, medium: 2, budget: 1 };

export function CompareProvidersModal({ open, onOpenChange }: CompareProvidersModalProps) {
  const [models, setModels] = useState<EmbeddingModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('provider');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (schemaOnly) params.set('schemaCompatibleOnly', 'true');
      if (freeOnly) params.set('hasFreeTier', 'true');
      if (localOnly) params.set('local', 'true');
      const url = `${API.ADMIN.ORCHESTRATION.EMBEDDING_MODELS}?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const body = (await res.json()) as { data?: EmbeddingModelInfo[] };
      if (body.data) setModels(body.data);
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [schemaOnly, freeOnly, localOnly]);

  useEffect(() => {
    if (open) void fetchModels();
  }, [open, fetchModels]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sorted = [...models].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortField) {
      case 'provider':
        return a.provider.localeCompare(b.provider) * dir;
      case 'cost':
        return (a.costPerMillionTokens - b.costPerMillionTokens) * dir;
      case 'quality':
        return ((QUALITY_ORDER[a.quality] ?? 0) - (QUALITY_ORDER[b.quality] ?? 0)) * dir;
      case 'dimensions':
        return (a.dimensions - b.dimensions) * dir;
      default:
        return 0;
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Compare Embedding Providers</DialogTitle>
          <DialogDescription>
            Anthropic (Claude) does not provide an embeddings API. Choose from the providers below
            for knowledge base vector search. Models marked{' '}
            <Badge variant="default" className="px-1 py-0 text-[10px]">
              Compatible
            </Badge>{' '}
            can produce 1 536-dimension vectors that work with the current database schema.
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 border-b py-2">
          <FilterToggle
            label="Schema-compatible only"
            active={schemaOnly}
            onToggle={() => setSchemaOnly((v) => !v)}
          />
          <FilterToggle
            label="Free tier"
            active={freeOnly}
            onToggle={() => setFreeOnly((v) => !v)}
          />
          <FilterToggle
            label="Local only"
            active={localOnly}
            onToggle={() => setLocalOnly((v) => !v)}
          />
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading models…</p>
          ) : sorted.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No models match the current filters.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <SortHeader
                    field="provider"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                  >
                    Provider
                  </SortHeader>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <SortHeader field="cost" current={sortField} dir={sortDir} onSort={toggleSort}>
                    Cost/1M
                  </SortHeader>
                  <th className="px-3 py-2 text-center font-medium">Free Tier</th>
                  <SortHeader
                    field="dimensions"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                  >
                    Dims
                  </SortHeader>
                  <th className="px-3 py-2 text-center font-medium">Compatible</th>
                  <SortHeader field="quality" current={sortField} dir={sortDir} onSort={toggleSort}>
                    Quality
                  </SortHeader>
                  <th className="px-3 py-2 text-left font-medium">Strengths</th>
                  <th className="px-3 py-2 text-left font-medium">Setup</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{m.provider}</td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{m.model}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {m.costPerMillionTokens === 0
                        ? 'Free'
                        : `$${m.costPerMillionTokens.toFixed(m.costPerMillionTokens < 0.1 ? 3 : 2)}`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {m.hasFreeTier ? (
                        <Check className="mx-auto h-4 w-4 text-green-600" />
                      ) : (
                        <X className="text-muted-foreground/40 mx-auto h-4 w-4" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{m.dimensions.toLocaleString()}</td>
                    <td className="px-3 py-2 text-center">
                      {m.schemaCompatible ? (
                        <Badge variant="default" className="text-[10px]">
                          Compatible
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          Incompatible
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <QualityBadge quality={m.quality} />
                    </td>
                    <td className="max-w-[200px] px-3 py-2 text-xs">{m.strengths}</td>
                    <td className="max-w-[180px] px-3 py-2 text-xs">{m.setup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <p className="text-muted-foreground text-xs">
            Pricing as of April 2026. Check provider docs for current rates.
          </p>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FilterToggle({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded-full border px-3 py-1 text-xs transition ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-muted-foreground/25 text-muted-foreground hover:border-primary/50'
      }`}
    >
      {label}
    </button>
  );
}

function SortHeader({
  field,
  current,
  dir,
  onSort,
  children,
}: {
  field: SortField;
  current: SortField;
  dir: SortDir;
  onSort: (f: SortField) => void;
  children: React.ReactNode;
}) {
  const active = field === current;
  return (
    <th className="px-3 py-2 text-left font-medium">
      <button
        type="button"
        onClick={() => onSort(field)}
        className="hover:text-foreground inline-flex items-center gap-1"
      >
        {children}
        <ArrowUpDown
          className={`h-3 w-3 ${active ? 'text-foreground' : 'text-muted-foreground/40'}`}
        />
        {active && <span className="text-[10px]">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}

function QualityBadge({ quality }: { quality: string }) {
  switch (quality) {
    case 'high':
      return (
        <Badge variant="default" className="text-[10px]">
          High
        </Badge>
      );
    case 'medium':
      return (
        <Badge variant="secondary" className="text-[10px]">
          Medium
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-[10px]">
          Budget
        </Badge>
      );
  }
}
