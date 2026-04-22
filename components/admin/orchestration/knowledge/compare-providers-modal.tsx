'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, HelpCircle, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';

const embeddingModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  dimensions: z.number(),
  schemaCompatible: z.boolean(),
  costPerMillionTokens: z.number(),
  hasFreeTier: z.boolean(),
  local: z.boolean(),
  quality: z.enum(['high', 'medium', 'budget']),
  strengths: z.string(),
  setup: z.string(),
});

type EmbeddingModelInfo = z.infer<typeof embeddingModelInfoSchema>;

const modelsResponseSchema = z.object({
  data: z.array(embeddingModelInfoSchema).optional(),
});

interface CompareProvidersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CompareProvidersModal({ open, onOpenChange }: CompareProvidersModalProps) {
  const [models, setModels] = useState<EmbeddingModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
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
      const body = modelsResponseSchema.parse(await res.json());
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
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
          ) : models.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No models match the current filters.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <TipHeader tip="The company or platform that hosts this embedding model.">
                    Provider
                  </TipHeader>
                  <TipHeader tip="The model identifier sent to the provider's API. You'll need this when configuring the embedding provider.">
                    Model
                  </TipHeader>
                  <TipHeader tip="Price per 1 million tokens of input text. A typical document page is ~500 tokens, so 1M tokens covers roughly 2,000 pages. Models showing 'Free' have no per-token charge (local models or free tiers).">
                    Cost/1M
                  </TipHeader>
                  <TipHeader
                    align="center"
                    tip="Whether the provider offers free credits or a free usage tier. Great for testing before committing — you can evaluate search quality without spending anything."
                  >
                    Free
                  </TipHeader>
                  <TipHeader tip="The number of values in each vector the model produces. Think of it as the resolution of the model's understanding — more dimensions capture finer distinctions between concepts, but use more storage. The database column is currently set to 1,536 dimensions.">
                    Dims
                  </TipHeader>
                  <TipHeader
                    align="center"
                    tip="Whether this model can produce vectors that fit the database's vector(1536) column. 'Compatible' means it either outputs 1,536 dimensions natively, or its API has a parameter to resize. 'Incompatible' means the output size is fixed at a different number — the model works fine, but you'd need a database migration to use it. Hover each badge for details."
                  >
                    Fits DB
                  </TipHeader>
                  <TipHeader
                    align="center"
                    tip="Relative retrieval quality based on industry benchmarks (MTEB). 'High' models find the most relevant results, 'Medium' is good for most use cases, 'Budget' trades some accuracy for lower cost or local operation."
                  >
                    Quality
                  </TipHeader>
                  <TipHeader tip="What this model is particularly good at and how to set it up.">
                    Notes
                  </TipHeader>
                </tr>
              </thead>
              <tbody className="divide-y">
                {models.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-2 py-2 text-xs font-medium whitespace-nowrap">
                      {m.provider}
                    </td>
                    <td className="px-2 py-2 font-mono text-[11px] whitespace-nowrap">{m.model}</td>
                    <td className="px-2 py-2 text-right text-xs whitespace-nowrap">
                      {m.costPerMillionTokens === 0
                        ? 'Free'
                        : `$${m.costPerMillionTokens.toFixed(m.costPerMillionTokens < 0.1 ? 3 : 2)}`}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {m.hasFreeTier ? (
                        <Check className="mx-auto h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <X className="text-muted-foreground/40 mx-auto h-3.5 w-3.5" />
                      )}
                    </td>
                    <td className="px-2 py-2 text-right text-xs">
                      {m.dimensions.toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <CompatibilityBadge model={m} />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <QualityBadge quality={m.quality} />
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <span className="line-clamp-2">{m.strengths}</span>
                    </td>
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

      {/* Why vector(1536)? */}
      <div>
        <p className="mb-1 font-semibold">Why is 1 536 the standard here?</p>
        <p>
          The database uses PostgreSQL with the{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">pgvector</code> extension,
          which stores embeddings in a fixed-width column. The column is defined as{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(1536)</code> in the
          Prisma schema &mdash; every vector stored must have exactly that many dimensions. This
          number was chosen because 1 536 is the native output size of OpenAI&apos;s{' '}
          <code className="font-mono">text-embedding-3-small</code>, which was the most widely
          adopted embedding model when the schema was created. It hits a practical sweet spot: large
          enough for good retrieval quality, small enough to keep storage and index costs
          reasonable.
        </p>
        <p className="mt-1">
          Common alternatives are{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(768)</code> (used by
          Google, Ollama/nomic &mdash; smaller, faster indexes, slightly less precision) and{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(3072)</code>{' '}
          (OpenAI&apos;s large model &mdash; highest fidelity, but doubles storage and slows
          nearest-neighbor search). You can change this value with a database migration, but every
          existing document must be re-embedded afterward because the old vectors will no longer fit
          the new column width.
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

      {/* What if I want to use an incompatible model? */}
      <div>
        <p className="mb-1 font-semibold">What if I want to use an incompatible model?</p>
        <p>
          You can. The dimension is not a hard limit of the system &mdash; it is a single value in a
          database migration. To switch to, say, 768 dimensions for a Google or Ollama model, you
          would: (1) create a Prisma migration that changes the column from{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(1536)</code> to{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(768)</code>, (2)
          update the embedding provider config to use the new model, and (3) re-embed all existing
          documents. Steps 1 and 2 take minutes. Step 3 depends on the size of your knowledge base
          &mdash; a few hundred documents finishes quickly, tens of thousands takes longer.
        </p>
        <p className="mt-1">
          A migration generator that automates this is planned but not yet built. For now, see the{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">prisma/schema.prisma</code>{' '}
          file &mdash; search for{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">vector(1536)</code> to find
          the column definition.
        </p>
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

/** Column header with tooltip on hover — no icon, just cursor hint. */
function TipHeader({
  tip,
  align = 'left',
  children,
}: {
  tip: string;
  align?: 'left' | 'center' | 'right';
  children: React.ReactNode;
}) {
  return (
    <th className={`px-2 py-2 text-${align} font-medium`}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help border-b border-dotted border-current/30">{children}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs font-normal">
            {tip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </th>
  );
}

const SCHEMA_DIMS = 1536;

/** Badge with a tooltip explaining why this specific model is compatible or not. */
function CompatibilityBadge({ model }: { model: EmbeddingModelInfo }) {
  const nativeDims = model.dimensions;

  let reason: string;
  if (model.schemaCompatible && nativeDims === SCHEMA_DIMS) {
    reason = `This model natively outputs ${SCHEMA_DIMS.toLocaleString()}-dimension vectors, which exactly matches the database column. No extra configuration needed.`;
  } else if (model.schemaCompatible && nativeDims !== SCHEMA_DIMS) {
    reason = `This model natively outputs ${nativeDims.toLocaleString()} dimensions, but its API accepts a parameter to resize the output to ${SCHEMA_DIMS.toLocaleString()}. The system sets this automatically — you get full compatibility with a minor quality trade-off from dimension reduction.`;
  } else {
    reason = `This model outputs ${nativeDims.toLocaleString()} dimensions and has no API option to resize. The database column expects exactly ${SCHEMA_DIMS.toLocaleString()} dimensions, so the vectors won't fit. To use this model, you'd need a database migration to change the column to vector(${nativeDims}), then re-embed all existing documents.`;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {model.schemaCompatible ? (
            <Badge variant="default" className="cursor-help text-[10px]">
              Yes
            </Badge>
          ) : (
            <Badge variant="outline" className="cursor-help text-[10px]">
              No
            </Badge>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs font-normal">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
