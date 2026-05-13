'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  RefreshCw,
  Sparkles,
  Sprout,
  Tag,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  CSV_MAX_ROW_CHARS,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
} from '@/lib/orchestration/knowledge/chunker-config';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import type { KnowledgeDocumentListItem } from '@/types/orchestration';

const metaTagEntrySchema = z.object({
  value: z.string(),
  chunkCount: z.number(),
  documentCount: z.number(),
});

const scopedMetaTagsSchema = z.object({
  categories: z.array(metaTagEntrySchema),
  keywords: z.array(metaTagEntrySchema),
});

const metaTagsResponseSchema = z.object({
  data: z
    .object({
      app: scopedMetaTagsSchema,
      system: scopedMetaTagsSchema,
    })
    .optional(),
});

const embeddingStatusResponseSchema = z.object({
  data: z
    .object({
      total: z.number(),
      embedded: z.number(),
      pending: z.number(),
      hasActiveProvider: z.boolean(),
    })
    .optional(),
});

const settingsResponseSchema = z.object({
  data: z.object({ lastSeededAt: z.string().nullable().optional() }).passthrough().optional(),
});

const errorBodySchema = z
  .object({
    error: z.object({ message: z.string().optional() }).optional(),
  })
  .nullable();

import { CompareProvidersModal } from '@/components/admin/orchestration/knowledge/compare-providers-modal';
import { DocumentChunksModal } from '@/components/admin/orchestration/knowledge/document-chunks-modal';
import { DocumentTagsModal } from '@/components/admin/orchestration/knowledge/document-tags-modal';
import { DocumentUploadZone } from '@/components/admin/orchestration/knowledge/document-upload-zone';
import type { PdfPreviewData } from '@/components/admin/orchestration/knowledge/document-upload-zone';
import { EmbeddingStatusBanner } from '@/components/admin/orchestration/knowledge/embedding-status-banner';
import { PdfPreviewModal } from '@/components/admin/orchestration/knowledge/pdf-preview-modal';

const STATUS_STYLES: Record<
  string,
  { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
> = {
  pending: { variant: 'outline', label: 'Pending' },
  pending_review: { variant: 'secondary', label: 'Needs Review' },
  processing: { variant: 'secondary', label: 'Processing' },
  ready: { variant: 'default', label: 'Ready' },
  failed: { variant: 'destructive', label: 'Failed' },
};

interface EmbeddingStatus {
  total: number;
  embedded: number;
  pending: number;
  hasActiveProvider: boolean;
}

interface MetaTagEntry {
  value: string;
  chunkCount: number;
  documentCount: number;
}

interface ScopedMetaTags {
  // Kept on the type so the API shape doesn't have to change, but the panel
  // no longer renders categories — they were the old chunk-level scoping
  // mechanism, replaced by Tags (see KnowledgeTag, Phase 2 of
  // knowledge-access-control). The /meta-tags endpoint still returns them
  // because the underlying chunk.category column is alive until Phase 6.
  categories: MetaTagEntry[];
  keywords: MetaTagEntry[];
}

interface MetaTagSummary {
  app: ScopedMetaTags;
  system: ScopedMetaTags;
}

const KEYWORD_COLLAPSED_LIMIT = 30;

/**
 * Extract the coverage metric the chunk pipeline writes to document
 * metadata (see lib/orchestration/knowledge/coverage.ts). Returns null
 * for older documents that pre-date the metric or rows where the JSON
 * shape isn't what we expect — the table renders a `—` in that case
 * rather than misleading the operator with a fabricated percentage.
 */
function readCoverage(metadata: unknown): { coveragePct: number } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const cov = (metadata as Record<string, unknown>).coverage;
  if (!cov || typeof cov !== 'object') return null;
  const pct = (cov as Record<string, unknown>).coveragePct;
  return typeof pct === 'number' ? { coveragePct: pct } : null;
}

function IndexedKeywordsSection({
  title,
  scope,
  defaultOpen,
  showAllKeywords,
  onToggleKeywords,
}: {
  title: string;
  scope: ScopedMetaTags;
  defaultOpen: boolean;
  showAllKeywords: boolean;
  onToggleKeywords: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasKws = scope.keywords.length > 0;
  const visibleKeywords = showAllKeywords
    ? scope.keywords
    : scope.keywords.slice(0, KEYWORD_COLLAPSED_LIMIT);

  if (!hasKws) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left text-xs font-medium"
      >
        <ChevronDown
          className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        {title}
        <span className="text-muted-foreground font-normal">
          ({scope.keywords.length} keywords)
        </span>
      </button>

      {open && (
        <div className="space-y-1 pl-5">
          <div className="flex flex-wrap gap-1">
            {visibleKeywords.map((tag) => (
              <Tip
                key={tag.value}
                label={`${tag.chunkCount} chunks across ${tag.documentCount} document${tag.documentCount === 1 ? '' : 's'}`}
              >
                <Badge variant="outline" className="text-xs">
                  {tag.value}
                </Badge>
              </Tip>
            ))}
          </div>
          {scope.keywords.length > KEYWORD_COLLAPSED_LIMIT && (
            <button
              type="button"
              onClick={onToggleKeywords}
              className="text-primary text-xs hover:underline"
            >
              {showAllKeywords ? 'Show less' : `Show all ${scope.keywords.length} keywords`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ManageTabProps {
  documents: KnowledgeDocumentListItem[];
  onRefresh: () => void;
}

export function ManageTab({ documents, onRefresh }: ManageTabProps) {
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [rechunkingId, setRechunkingId] = useState<string | null>(null);
  const [rechunkError, setRechunkError] = useState<string | null>(null);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [enrichConfirmId, setEnrichConfirmId] = useState<string | null>(null);
  const [enrichSuccess, setEnrichSuccess] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [lastSeededAt, setLastSeededAt] = useState<string | null>(null);
  const [metaTags, setMetaTags] = useState<MetaTagSummary | null>(null);
  const [showAllAppKeywords, setShowAllAppKeywords] = useState(false);
  const [showAllSystemKeywords, setShowAllSystemKeywords] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewData | null>(null);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [viewChunksId, setViewChunksId] = useState<string | null>(null);
  const [viewChunksName, setViewChunksName] = useState<string | null>(null);
  // Separate state so the Tags chip on a row opens the tag editor directly,
  // not the chunks list — two modals, one job each.
  const [editTagsId, setEditTagsId] = useState<string | null>(null);
  const [editTagsName, setEditTagsName] = useState<string | null>(null);
  const [setupPreference, setSetupPreference] = useLocalStorage<'open' | 'closed' | null>(
    'orchestration.knowledge.builtin-patterns-panel',
    null
  );

  const fetchMetaTags = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_META_TAGS);
      if (!res.ok) return;
      const body = metaTagsResponseSchema.parse(await res.json());
      if (body.data?.app && body.data?.system) setMetaTags(body.data);
    } catch {
      // Supplementary — ignore failures
    }
  }, []);

  const fetchEmbeddingStatus = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDING_STATUS);
      if (!res.ok) return;
      const body = embeddingStatusResponseSchema.parse(await res.json());
      if (body.data) setEmbeddingStatus(body.data);
    } catch {
      // Silently ignore — status is supplementary
    }
  }, []);

  const fetchLastSeededAt = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS);
      if (!res.ok) return;
      const body = settingsResponseSchema.parse(await res.json());
      if (body.data?.lastSeededAt) setLastSeededAt(body.data.lastSeededAt);
    } catch {
      // Silently ignore — supplementary info
    }
  }, []);

  useEffect(() => {
    void fetchEmbeddingStatus();
    void fetchLastSeededAt();
    void fetchMetaTags();
  }, [fetchEmbeddingStatus, fetchLastSeededAt, fetchMetaTags]);

  const handleSeed = useCallback(async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEED, { method: 'POST' });
      if (!res.ok) {
        const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
        setSeedError(
          (raw.success ? raw.data?.error?.message : null) ?? `Load failed (${res.status})`
        );
        return;
      }
      onRefresh();
      void fetchEmbeddingStatus();
      void fetchLastSeededAt();
    } catch {
      setSeedError('Network error — could not reach the server.');
    } finally {
      setSeeding(false);
    }
  }, [onRefresh, fetchEmbeddingStatus, fetchLastSeededAt]);

  const handleEmbed = useCallback(async () => {
    setEmbedding(true);
    setEmbedError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBED, { method: 'POST' });
      if (!res.ok) {
        const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
        setEmbedError(
          (raw.success ? raw.data?.error?.message : null) ?? `Embedding failed (${res.status})`
        );
        return;
      }
      void fetchEmbeddingStatus();
    } catch {
      setEmbedError('Network error — could not reach the server.');
    } finally {
      setEmbedding(false);
    }
  }, [fetchEmbeddingStatus]);

  const handleRechunk = useCallback(
    async (docId: string) => {
      setRechunkingId(docId);
      setRechunkError(null);
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentRechunk(docId), {
          method: 'POST',
        });
        if (!res.ok) {
          const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
          const msg =
            (raw.success ? raw.data?.error?.message : null) ?? `Rechunk failed (${res.status})`;
          setRechunkError(msg);
          return;
        }
        onRefresh();
      } catch {
        setRechunkError('Network error — could not reach the server.');
      } finally {
        setRechunkingId(null);
      }
    },
    [onRefresh]
  );

  const handleEnrichKeywords = useCallback(
    async (docId: string) => {
      setEnrichingId(docId);
      setEnrichError(null);
      setEnrichSuccess(null);
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentEnrichKeywords(docId), {
          method: 'POST',
        });
        if (!res.ok) {
          const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
          const msg =
            (raw.success ? raw.data?.error?.message : null) ?? `Enrich failed (${res.status})`;
          setEnrichError(msg);
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          success?: boolean;
          data?: {
            chunksProcessed?: number;
            chunksFailed?: number;
            chunksSkipped?: number;
            costUsd?: number;
            model?: string;
          };
        } | null;
        const data = body?.data;
        const processed = data?.chunksProcessed ?? 0;
        const failed = data?.chunksFailed ?? 0;
        const cost = data?.costUsd ?? 0;
        const parts = [`Enriched ${processed} chunk${processed === 1 ? '' : 's'}`];
        if (failed > 0) parts.push(`${failed} failed`);
        parts.push(`~$${cost.toFixed(4)}`);
        setEnrichSuccess(parts.join(' · '));
        onRefresh();
        void fetchMetaTags();
      } catch {
        setEnrichError('Network error — could not reach the server.');
      } finally {
        setEnrichingId(null);
        setEnrichConfirmId(null);
      }
    },
    [onRefresh, fetchMetaTags]
  );

  const handleDelete = useCallback(
    async (docId: string) => {
      setDeletingId(docId);
      setDeleteError(null);
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(docId), {
          method: 'DELETE',
        });
        if (!res.ok) {
          const raw = errorBodySchema.safeParse(await res.json().catch(() => null));
          setDeleteError(
            (raw.success ? raw.data?.error?.message : null) ?? `Delete failed (${res.status})`
          );
          return;
        }
        onRefresh();
        void fetchMetaTags();
        void fetchEmbeddingStatus();
      } catch {
        setDeleteError('Network error — could not reach the server.');
      } finally {
        setDeletingId(null);
        setDeleteConfirmId(null);
      }
    },
    [onRefresh, fetchMetaTags, fetchEmbeddingStatus]
  );

  const handlePdfPreview = useCallback((data: PdfPreviewData) => {
    setPdfPreview(data);
    setPdfPreviewOpen(true);
  }, []);

  const hasChunks = embeddingStatus !== null && embeddingStatus.total > 0;
  const hasProvider = embeddingStatus?.hasActiveProvider ?? false;
  const allEmbedded =
    embeddingStatus !== null && embeddingStatus.total > 0 && embeddingStatus.pending === 0;
  const embedDisabled = embedding || !hasChunks || !hasProvider || allEmbedded;

  // Categories are intentionally ignored here — the panel now shows only the
  // BM25 keyword index. See "Indexed keywords" panel below.
  const hasAppKeywords = metaTags !== null && metaTags.app.keywords.length > 0;
  const hasSystemKeywords = metaTags !== null && metaTags.system.keywords.length > 0;

  // Built-in setup panel: collapsed by default once setup is complete (chunks loaded
  // and all embedded). Manual user preference (open/closed) wins over the auto rule.
  const setupComplete = hasChunks && allEmbedded;
  const setupOpen = setupPreference === null ? !setupComplete : setupPreference === 'open';

  // Built-in setup panel JSX — assigned to a variable so we can render it
  // either near the top of the page (while setup is in progress) or at the
  // bottom (once setupComplete, since it's no longer the operator's focus).
  const builtInPanel = (
    <div className="border-primary/30 from-primary/5 rounded-lg border border-dashed bg-gradient-to-br to-transparent">
      <button
        type="button"
        onClick={() => setSetupPreference(setupOpen ? 'closed' : 'open')}
        className="hover:bg-primary/5 flex w-full items-center gap-2 rounded-t-lg px-4 py-3 text-left transition-colors"
        aria-expanded={setupOpen}
      >
        <Sparkles className="text-primary h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Built-in: Agentic Design Patterns</h3>
            <Badge variant="outline" className="text-[10px] tracking-wide uppercase">
              One-time setup
            </Badge>
            {setupComplete && (
              <span className="text-primary inline-flex items-center gap-1 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Complete
              </span>
            )}
          </div>
          {!setupOpen && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {setupComplete
                ? 'Patterns loaded and embedded. Click to expand.'
                : !hasChunks
                  ? 'Load the built-in patterns to enable the Learning page.'
                  : !hasProvider
                    ? 'Configure an embedding provider to enable vector search.'
                    : `${embeddingStatus?.embedded ?? 0}/${embeddingStatus?.total ?? 0} chunks embedded.`}
            </p>
          )}
        </div>
        <ChevronDown
          className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform ${setupOpen ? '' : '-rotate-90'}`}
        />
      </button>

      {setupOpen && (
        <div className="border-primary/20 space-y-3 border-t border-dashed px-4 pt-3 pb-4">
          <p className="text-muted-foreground text-xs">
            Sunrise ships with a pre-chunked guide covering 21 agentic design patterns.{' '}
            <strong>Step 1:</strong> Load the patterns (no API key needed). <strong>Step 2:</strong>{' '}
            Generate embeddings to enable vector search (requires an embedding provider).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Button
                onClick={() => void handleSeed()}
                disabled={seeding}
                variant="outline"
                size="sm"
              >
                <Sprout className="mr-1 h-4 w-4" />
                {seeding ? 'Loading...' : 'Load Agentic Design Patterns'}
              </Button>
              <FieldHelp
                title="Load Agentic Design Patterns"
                ariaLabel="What does Load Patterns do?"
              >
                <p>
                  Inserts all pre-chunked content from the built-in <em>Agentic Design Patterns</em>{' '}
                  guide into the database. The Learning Patterns page works immediately — no
                  embedding provider needed.
                </p>
                <p className="mt-2">
                  Adapted from <em>Agentic Design Patterns</em> by Antonio Gullí.
                </p>
                <p className="mt-2">
                  If the patterns are already loaded, clicking again has no effect.
                </p>
              </FieldHelp>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                onClick={() => void handleEmbed()}
                disabled={embedDisabled}
                variant="outline"
                size="sm"
                title={
                  !hasChunks
                    ? 'Load Agentic Design Patterns first'
                    : !hasProvider
                      ? 'Configure an embedding provider first'
                      : allEmbedded
                        ? 'All chunks are already embedded'
                        : undefined
                }
              >
                <Cpu className="mr-1 h-4 w-4" />
                {embedding ? 'Embedding...' : 'Generate Embeddings'}
              </Button>
              <FieldHelp
                title="Generate Embeddings"
                ariaLabel="What does Generate Embeddings do?"
                contentClassName="w-80 max-h-80 overflow-y-auto"
              >
                <p>
                  Sends each unembedded chunk to the configured embedding model to generate a vector
                  (a numerical fingerprint of its meaning). These vectors enable similarity search
                  so the Advisor, Quiz, and Search can find relevant content.
                </p>
                <p className="mt-2">
                  Requires a configured <strong>embedding provider</strong>. Recommended options:
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                  <li>
                    <strong>Voyage AI</strong> — best retrieval quality, free tier (200 M
                    tokens/month)
                  </li>
                  <li>
                    <strong>OpenAI</strong> — text-embedding-3-small, low cost, native 1 536 dims
                  </li>
                  <li>
                    <strong>Ollama</strong> — local, free, but 768-dim (requires schema change)
                  </li>
                </ul>
                <p className="mt-2 text-xs">
                  <strong>Note:</strong> Anthropic (Claude) does not offer an embeddings API. Only
                  processes chunks that don&apos;t have embeddings yet, so it&apos;s safe to run
                  multiple times.
                </p>
              </FieldHelp>
              {embeddingStatus && hasChunks && !allEmbedded && (
                <span className="text-muted-foreground text-xs">
                  {embeddingStatus.embedded}/{embeddingStatus.total} embedded
                </span>
              )}
              {allEmbedded && (
                <span className="text-muted-foreground text-xs">All chunks embedded</span>
              )}
            </div>
          </div>
          <div>
            <button
              type="button"
              onClick={() => setCompareOpen(true)}
              className="text-primary text-xs hover:underline"
            >
              Compare embedding providers →
            </button>
          </div>
          {lastSeededAt && (
            <p className="text-muted-foreground text-xs">
              Last seeded:{' '}
              {new Date(lastSeededAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          )}
          {seedError && <p className="text-destructive text-sm">{seedError}</p>}
          {embedError && <p className="text-destructive text-sm">{embedError}</p>}
          {embeddingStatus && hasChunks && !allEmbedded && embeddingStatus.embedded > 0 && (
            <EmbeddingStatusBanner
              total={embeddingStatus.total}
              embedded={embeddingStatus.embedded}
              hasActiveProvider={hasProvider}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {/* General knowledge base explainer */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          How does the knowledge base work?{' '}
          <FieldHelp
            title="Knowledge Base — how it works"
            ariaLabel="How the knowledge base works"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              The knowledge base lets your AI agents answer questions using your own documents
              instead of relying only on their training data.
            </p>
            <p className="text-foreground mt-2 font-medium">1. Chunking</p>
            <p>
              A long document is split into smaller overlapping pieces called{' '}
              <strong>chunks</strong> (a few paragraphs each). This is necessary because AI models
              have a limited context window — they can only read so much text at once. Smaller
              chunks also mean the system can find the most relevant snippet rather than feeding the
              entire document to the model.
            </p>
            <p className="text-foreground mt-2 font-medium">2. Embedding</p>
            <p>
              Each chunk is sent to an <strong>embedding model</strong> (a specialised AI, not the
              chat model) which converts the text into a list of numbers called a{' '}
              <strong>vector</strong> — think of it as a unique fingerprint that captures the
              meaning of the text. Similar texts produce similar vectors, even if they use different
              words.
            </p>
            <p className="text-foreground mt-2 font-medium">3. Vector storage</p>
            <p>
              The vectors are stored in the database alongside the original text (PostgreSQL with
              the <code>pgvector</code> extension). When a user asks a question, the question is
              also converted to a vector, and the database finds the chunks whose vectors are
              closest in meaning — this is called <strong>similarity search</strong>.
            </p>
            <p className="text-foreground mt-2 font-medium">
              4. Retrieval-Augmented Generation (RAG)
            </p>
            <p>
              The matching chunks are injected into the chat prompt so the LLM can read them and
              compose an answer grounded in your documents. The LLM itself does not store the
              knowledge — it reads the relevant chunks on every request.
            </p>
            <p className="text-foreground mt-2 font-medium">Can I undo this?</p>
            <p>
              Yes. Deleting a document permanently removes the document, all its chunks, and all
              associated embeddings from the database. The document will no longer appear in search
              results and agents will not be able to reference it. Nothing is retained.
            </p>
            <p className="text-foreground mt-2 font-medium">How do I update a document?</p>
            <p>
              There is no versioning — each upload is treated as a standalone document. To update a
              document, delete the old version first, then upload the revised file. The old chunks
              and embeddings are removed on delete, and the new upload will be chunked and embedded
              from scratch. If you upload a file with identical content to one that already exists,
              the system will recognise the duplicate and return the existing document instead of
              creating a new one.
            </p>
            <p className="text-foreground mt-2 font-medium">Example</p>
            <p>
              You upload a 50-page design-patterns guide. It gets split into ~80 chunks, each chunk
              is embedded into a 1 536-number vector, and those vectors are saved. Later, a user
              asks <em>&quot;When should I use the fan-out pattern?&quot;</em> The system embeds
              that question, finds the 3 closest chunks about fan-out, and passes them to the LLM,
              which writes a clear answer citing your guide.
            </p>
          </FieldHelp>
        </span>
      </div>

      {/* Built-in setup renders near the top while still in progress so it
          stays in the operator's path of attention. Once setupComplete, it
          falls to the bottom of the page (see end of this component) since
          it's already done and shouldn't take prime real estate. */}
      {!setupComplete && builtInPanel}

      <DocumentUploadZone onUploadComplete={onRefresh} onPdfPreview={handlePdfPreview} />

      {/* Chunking settings — accessed via an ⓘ button underneath the upload
          zone. The popover surfaces both the live values and the advice for
          when to change them. Values come from `chunker-config.ts` so they
          can never drift from what the runtime uses. */}
      <div className="text-muted-foreground -mt-4 flex items-center gap-1.5 text-xs">
        <span>Chunking settings</span>
        <FieldHelp
          title="Chunking settings"
          ariaLabel="About the chunking settings"
          contentClassName="w-96 max-h-96 overflow-y-auto"
        >
          <p>
            These values control how documents are split into chunks before embedding. They are{' '}
            <strong>code-level constants</strong> today — there is no admin UI to change them. The
            values below are what the runtime actually uses, read directly from{' '}
            <code>lib/orchestration/knowledge/chunker-config.ts</code>.
          </p>

          <dl className="bg-muted/40 mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md p-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Min chunk size</dt>
              <dd className="font-medium">{MIN_CHUNK_TOKENS} tokens</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max chunk size</dt>
              <dd className="font-medium">{MAX_CHUNK_TOKENS} tokens</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Token estimate</dt>
              <dd className="font-medium">~{CHARS_PER_TOKEN_ESTIMATE} chars / token</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">CSV row cap</dt>
              <dd className="font-medium">{CSV_MAX_ROW_CHARS.toLocaleString()} chars</dd>
            </div>
          </dl>

          <p className="text-foreground mt-3 font-medium">Chunk size (min/max tokens)</p>
          <p>
            The chunker aims for chunks between <strong>{MIN_CHUNK_TOKENS}</strong> and{' '}
            <strong>{MAX_CHUNK_TOKENS}</strong> tokens. Below the min, neighbouring sections merge;
            above the max, sections split. <strong>Smaller chunks</strong> = sharper similarity
            match (good for FAQs, glossaries); <strong>larger chunks</strong> = more surrounding
            context per match (good for long-form prose, legal text).
          </p>
          <p className="text-foreground mt-2 font-medium">Token estimation</p>
          <p>
            Tokens are approximated as <strong>~{CHARS_PER_TOKEN_ESTIMATE}</strong> characters per
            token (a common rule of thumb for English). The chunker doesn&apos;t call the embedding
            provider&apos;s tokenizer — it&apos;s a heuristic.
          </p>
          <p className="text-foreground mt-2 font-medium">Split hierarchy</p>
          <p>
            When a section exceeds the max, the chunker tries to split it cleanly in this order:{' '}
            <strong>paragraph → line → sentence → fixed-width window</strong>. The last tier is the
            safety net that guarantees no chunk ever exceeds the cap, at the cost of cutting
            mid-sentence.
          </p>
          <p className="text-foreground mt-2 font-medium">CSV per-row cap</p>
          <p>
            CSV uploads chunk one row per chunk. Rows above{' '}
            <strong>{CSV_MAX_ROW_CHARS.toLocaleString()}</strong> characters are dropped before
            embedding (they exceed every embedding API&apos;s input limit) and named in the document
            warnings.
          </p>
          <p className="text-foreground mt-2 font-medium">When to change these</p>
          <p>
            Rarely. Defaults work well for OpenAI, Voyage, and Ollama embeddings. Consider a change
            only if (a) you switch to a smaller-context embedding model, (b) your documents are
            uniformly very short or very long, or (c) coverage on most documents is consistently
            low.
          </p>
        </FieldHelp>
      </div>

      {/* Indexed keywords — search-relevance diagnostic. NOT a configuration
          surface: tags are how operators scope agent access (see the Tags tab). */}
      {metaTags && (hasAppKeywords || hasSystemKeywords) && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-1.5">
            <Tag className="text-muted-foreground h-4 w-4" />
            <h3 className="text-sm font-medium">Indexed keywords</h3>
            <FieldHelp
              title="Indexed keywords"
              ariaLabel="About indexed keywords"
              contentClassName="w-96 max-h-96 overflow-y-auto"
            >
              <p>
                Distinct keyword values found across knowledge-base chunks, with chunk and document
                counts. Keywords feed the BM25 component of hybrid search — chunks whose keywords
                match the query get a relevance boost added to the vector-similarity score. Keywords
                affect <em>how</em> a chunk ranks for a query; they never affect <em>who</em> can
                see it. (For access scoping, see Tags.)
              </p>
              <p className="text-foreground mt-2 font-medium">How keywords are created</p>
              <p>
                This is a <strong>diagnostic</strong>, not a direct edit surface. Two sources today:
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                <li>
                  <strong>Metadata comments</strong> inside markdown documents — a chunker pass
                  reads <code className="text-[10px]">{'<!-- metadata: keywords="..." -->'}</code>{' '}
                  and writes the comma-separated value onto each chunk in scope. DOCX, PDF, EPUB,
                  and CSV uploads don&apos;t go through this path, so keywords stay NULL by default.
                </li>
                <li>
                  <strong>The Enrich Keywords action</strong> on each document row — runs an LLM
                  over every chunk and writes 3–8 keyword phrases. Use this when an upload
                  doesn&apos;t rank for queries whose vocabulary differs from the content.
                </li>
              </ul>
              <p className="mt-2 text-xs">
                Empty keywords are fine: BM25 still indexes the chunk content. Keywords are a
                precision dial, not the primary lexical signal.
              </p>
              <p className="mt-2 text-xs">
                <strong>App knowledge</strong> = your uploaded documents.{' '}
                <strong>System knowledge</strong> = the built-in Agentic Design Patterns reference
                (read-only).
              </p>
            </FieldHelp>
          </div>

          {hasAppKeywords && (
            <IndexedKeywordsSection
              title="App knowledge"
              scope={metaTags.app}
              defaultOpen
              showAllKeywords={showAllAppKeywords}
              onToggleKeywords={() => setShowAllAppKeywords((v) => !v)}
            />
          )}

          {hasSystemKeywords && (
            <IndexedKeywordsSection
              title="System knowledge"
              scope={metaTags.system}
              defaultOpen={false}
              showAllKeywords={showAllSystemKeywords}
              onToggleKeywords={() => setShowAllSystemKeywords((v) => !v)}
            />
          )}
        </div>
      )}

      {/* Document list */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Documents ({documents.length})</h3>

        {documents.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm">No documents yet.</p>
            <p className="mt-1 text-xs">
              Upload a file or load the built-in patterns to get started.
            </p>
          </div>
        ) : (
          <>
            {rechunkError && <p className="text-destructive text-sm">{rechunkError}</p>}
            {deleteError && <p className="text-destructive text-sm">{deleteError}</p>}
            {enrichError && <p className="text-destructive text-sm">{enrichError}</p>}
            {enrichSuccess && <p className="text-sm text-emerald-600">{enrichSuccess}</p>}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">
                      <Tip label="The document name — click to view details">
                        <span>Name</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      <Tip label="Knowledge tags applied to this document — click a chip (or the document name) to edit. Tags determine which restricted-mode agents can search the document.">
                        <span>Tags</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      <Tip label="Processing status — pending, processing, ready, or failed">
                        <span>Status</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      <Tip label="Number of text chunks this document was split into for vector search">
                        <span>Chunks</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      <Tip label="Percentage of the parsed source text that was captured in stored chunks. Click the document to see details.">
                        <span>Coverage</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      <Tip label="When this document was uploaded">
                        <span>Uploaded</span>
                      </Tip>
                    </th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {documents.map((doc) => {
                    const style = STATUS_STYLES[doc.status] ?? STATUS_STYLES.pending;
                    const isSeeded = doc.fileName === 'agentic-design-patterns.md';
                    return (
                      <tr key={doc.id}>
                        <td className="px-4 py-2 font-medium">
                          <button
                            type="button"
                            onClick={() => {
                              setViewChunksId(doc.id);
                              setViewChunksName(doc.name);
                            }}
                            className="text-primary text-left hover:underline"
                            title="View chunks"
                          >
                            {doc.name}
                          </button>
                        </td>
                        <td className="px-4 py-2">
                          {doc.tags && doc.tags.length > 0 ? (
                            <Tip
                              label={`${doc.tags.map((t) => t.name).join(', ')} — click to edit`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setEditTagsId(doc.id);
                                  setEditTagsName(doc.name);
                                }}
                                aria-label={`Edit ${doc.tags.length} tag${doc.tags.length === 1 ? '' : 's'} on ${doc.name}`}
                                className="focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
                              >
                                <Badge variant="secondary" className="text-xs hover:underline">
                                  {doc.tags.length} tag{doc.tags.length === 1 ? '' : 's'}
                                </Badge>
                              </button>
                            </Tip>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setEditTagsId(doc.id);
                                setEditTagsName(doc.name);
                              }}
                              className="text-muted-foreground hover:text-foreground text-xs hover:underline"
                              title="No tags — click to add"
                            >
                              + Add
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={style.variant}>{style.label}</Badge>
                        </td>
                        <td className="px-4 py-2 text-right">{doc.chunkCount}</td>
                        <td className="px-4 py-2 text-right text-xs">
                          {(() => {
                            const cov = readCoverage(doc.metadata);
                            if (!cov) {
                              return (
                                <Tip label="No coverage metric — this document was uploaded before coverage was tracked. Re-chunk to compute it.">
                                  <span className="text-muted-foreground">—</span>
                                </Tip>
                              );
                            }
                            const healthy = cov.coveragePct >= 95;
                            const label = healthy
                              ? `${cov.coveragePct}% of the parsed source text was captured in stored chunks — ≥95% is healthy. Click the document name to inspect the chunks.`
                              : `Only ${cov.coveragePct}% of the parsed source text made it into chunks. Some content was likely dropped by the chunker (oversize CSV rows, empty paragraph splits). Click the document name to review.`;
                            return (
                              <Tip label={label}>
                                <span
                                  className={
                                    healthy
                                      ? 'text-green-700 dark:text-green-400'
                                      : 'text-amber-700 dark:text-amber-400'
                                  }
                                >
                                  {cov.coveragePct}%
                                </span>
                              </Tip>
                            );
                          })()}
                        </td>
                        <td className="text-muted-foreground px-4 py-2 text-xs">
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            {isSeeded ? (
                              <>
                                <Badge variant="outline" className="text-xs">
                                  Pre-chunked
                                </Badge>
                                <FieldHelp
                                  title="Pre-chunked"
                                  ariaLabel="Why can't this be rechunked?"
                                >
                                  <p>
                                    This document was loaded from the built-in Agentic Design
                                    Patterns data, which ships pre-chunked with optimised section
                                    boundaries. Rechunking would use the generic chunker and produce
                                    lower-quality splits.
                                  </p>
                                  <p className="mt-2">
                                    To refresh this data, use the{' '}
                                    <strong>Load Agentic Design Patterns</strong> button above (it
                                    will skip if already loaded).
                                  </p>
                                </FieldHelp>
                              </>
                            ) : (
                              <>
                                {doc.status === 'pending_review' ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setViewChunksId(doc.id);
                                      setViewChunksName(doc.name);
                                    }}
                                  >
                                    <Eye className="mr-1 h-3 w-3" />
                                    Review
                                  </Button>
                                ) : (
                                  <Tip label="Re-splits the document into chunks and re-embeds them from scratch. Useful after switching embedding provider (so the new vectors are used), to retry a document with low coverage, or after a code-level chunker upgrade. Existing chunks and embeddings are replaced — agents will use the new ones immediately.">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={rechunkingId === doc.id}
                                      onClick={() => void handleRechunk(doc.id)}
                                    >
                                      <RefreshCw
                                        className={`mr-1 h-3 w-3 ${rechunkingId === doc.id ? 'animate-spin' : ''}`}
                                      />
                                      Rechunk
                                    </Button>
                                  </Tip>
                                )}
                                {doc.status === 'pending_review' ? null : enrichConfirmId ===
                                  doc.id ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-muted-foreground text-xs">
                                      Overwrite keywords on every chunk?
                                    </span>
                                    <Button
                                      variant="default"
                                      size="sm"
                                      disabled={enrichingId === doc.id}
                                      onClick={() => void handleEnrichKeywords(doc.id)}
                                    >
                                      {enrichingId === doc.id ? 'Enriching…' : 'Yes'}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setEnrichConfirmId(null)}
                                    >
                                      No
                                    </Button>
                                  </span>
                                ) : (
                                  <Tip label="Run an LLM over every chunk to generate 3–8 BM25 keyword phrases. Overwrites existing keywords. Use when hybrid-search ranking is weak because the chunk vocabulary doesn't match how users phrase queries. Cost scales with chunk count and the configured chat model.">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={enrichingId === doc.id}
                                      onClick={() => setEnrichConfirmId(doc.id)}
                                    >
                                      <Sparkles
                                        className={`mr-1 h-3 w-3 ${enrichingId === doc.id ? 'animate-pulse' : ''}`}
                                      />
                                      Enrich keywords
                                    </Button>
                                  </Tip>
                                )}
                                {deleteConfirmId === doc.id ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-destructive text-xs">
                                      Delete? Chunks &amp; embeddings will also be removed.
                                    </span>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      disabled={deletingId === doc.id}
                                      onClick={() => void handleDelete(doc.id)}
                                    >
                                      {deletingId === doc.id ? 'Deleting...' : 'Yes'}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setDeleteConfirmId(null)}
                                    >
                                      No
                                    </Button>
                                  </span>
                                ) : (
                                  <Tip label="Permanently delete this document, all its chunks, and their embeddings">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setDeleteConfirmId(doc.id)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </Tip>
                                )}
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <CompareProvidersModal open={compareOpen} onOpenChange={setCompareOpen} />
      <PdfPreviewModal
        data={pdfPreview}
        open={pdfPreviewOpen}
        onOpenChange={setPdfPreviewOpen}
        onConfirmed={() => {
          onRefresh();
          void fetchEmbeddingStatus();
          void fetchMetaTags();
        }}
      />
      <DocumentChunksModal
        documentId={viewChunksId}
        documentName={viewChunksName}
        open={viewChunksId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewChunksId(null);
            setViewChunksName(null);
          }
        }}
      />
      <DocumentTagsModal
        documentId={editTagsId}
        documentName={editTagsName}
        open={editTagsId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditTagsId(null);
            setEditTagsName(null);
          }
        }}
      />

      {/* Built-in setup falls to the bottom once complete — out of the
          operator's path of attention but still reachable (collapsed by
          default, can be expanded). The active-setup rendering near the
          top is the same panel; only one renders at a time. */}
      {setupComplete && builtInPanel}
    </div>
  );
}
