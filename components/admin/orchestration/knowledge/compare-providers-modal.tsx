'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpDown, Check, ChevronDown, ChevronUp, HelpCircle, X } from 'lucide-react';

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
  const [showGuide, setShowGuide] = useState(false);

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
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Embeddings convert text into lists of numbers (vectors) so the database can find
                semantically similar content. Claude handles the chat, but a separate embedding
                model handles search &mdash; they are different tasks that use different models.
              </p>
              <button
                type="button"
                onClick={() => setShowGuide((v) => !v)}
                className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-xs font-medium"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {showGuide ? 'Hide' : 'How do I choose? What does Compatible mean?'}
                {showGuide ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
              {showGuide && (
                <div className="max-h-[40vh] overflow-y-auto">
                  <EmbeddingGuide />
                </div>
              )}
            </div>
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

function EmbeddingGuide() {
  return (
    <div className="bg-muted/50 space-y-3 rounded-lg border p-3 text-xs leading-relaxed">
      {/* What are dimensions? */}
      <div>
        <p className="mb-1 font-semibold">What are dimensions?</p>
        <p>
          Each embedding model outputs a fixed-length vector. A 1 024-dimension model turns every
          piece of text into a list of 1 024 numbers; a 1 536-dimension model produces 1 536
          numbers. More dimensions can capture finer-grained meaning, but they use more storage and
          are slightly slower to search.
        </p>
      </div>

      {/* What does Compatible / Incompatible mean? */}
      <div>
        <p className="mb-1 font-semibold">What does Compatible / Incompatible mean?</p>
        <p>
          The database column that stores embeddings is currently set to{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(1536)</code> &mdash;
          it only accepts vectors with exactly 1 536 dimensions. A model marked{' '}
          <span className="bg-primary text-primary-foreground inline-flex items-center rounded-md px-1 py-0 font-medium">
            Compatible
          </span>{' '}
          either produces 1 536 dimensions natively, or has an API parameter to resize its output to
          1 536. An{' '}
          <span className="inline-flex items-center rounded-md border px-1 py-0 font-medium">
            Incompatible
          </span>{' '}
          model produces a different dimension count (e.g. 768 or 1 024) with no option to resize.
        </p>
        <p className="mt-1">
          <strong>The model is not broken</strong> &mdash; the constraint is on our side. You could
          make any model work by running a database migration to change the column to match (e.g.{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(768)</code> for
          Google or Ollama). The trade-off: you lose the ability to swap between models without
          re-embedding all your documents, since vectors of different sizes are not interchangeable.
        </p>
      </div>

      {/* Can I change my mind later? */}
      <div>
        <p className="mb-1 font-semibold">Can I change my mind later?</p>
        <p>
          Yes, but it takes work. Switching embedding models means every document must be
          re-embedded with the new model, because different models place concepts at different
          positions in vector space &mdash; a vector from OpenAI and a vector from Voyage are not
          comparable even if they are the same length. If your knowledge base is small (hundreds of
          documents), re-embedding takes minutes. At tens of thousands, it takes longer and costs
          more. Pick a model you are comfortable with, but do not agonize &mdash; switching is
          possible, just not free.
        </p>
      </div>

      {/* How to decide */}
      <div>
        <p className="mb-1 font-semibold">How to decide</p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <strong>Getting started / prototyping:</strong> Pick a compatible model with a free
            tier. Voyage AI is the recommended default &mdash; high quality, generous free quota,
            and built specifically for retrieval.
          </li>
          <li>
            <strong>Tightest budget:</strong> OpenAI{' '}
            <code className="font-mono">text-embedding-3-small</code> is the cheapest compatible
            option. Google is even cheaper but requires a schema migration.
          </li>
          <li>
            <strong>Best quality:</strong> OpenAI{' '}
            <code className="font-mono">text-embedding-3-large</code> or Voyage 3 &mdash; both score
            highest on retrieval benchmarks and are compatible.
          </li>
          <li>
            <strong>Data privacy / air-gap:</strong> Ollama models run entirely on your machine.
            Nothing leaves your network. They require a schema migration since they output 768 or 1
            024 dimensions.
          </li>
          <li>
            <strong>Multilingual content:</strong> Cohere Multilingual v3 is purpose-built for 100+
            languages, but is currently incompatible (1 024-dim, needs a schema migration).
          </li>
        </ul>
      </div>

      {/* What if I pick the wrong one? */}
      <div>
        <p className="mb-1 font-semibold">What if I pick the wrong one?</p>
        <p>
          There is no catastrophically wrong choice. All models in this list are production-grade.
          The worst case is that you switch later and re-embed &mdash; a reversible operation that
          costs time and a small amount of money. Start with something compatible, upload a few
          documents, test search quality. If it is good enough, ship it. If not, try another.
        </p>
      </div>
    </div>
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
