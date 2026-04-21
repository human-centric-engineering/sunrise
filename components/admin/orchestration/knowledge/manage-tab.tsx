'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Cpu, Eye, RefreshCw, Sprout, Tag, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';
import type { AiKnowledgeDocument } from '@/types/orchestration';

const metaTagsResponseSchema = z.object({
  data: z
    .object({ app: z.record(z.string(), z.unknown()), system: z.record(z.string(), z.unknown()) })
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
  categories: MetaTagEntry[];
  keywords: MetaTagEntry[];
}

interface MetaTagSummary {
  app: ScopedMetaTags;
  system: ScopedMetaTags;
}

const KEYWORD_COLLAPSED_LIMIT = 30;

function MetaTagSection({
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
  const hasCats = scope.categories.length > 0;
  const hasKws = scope.keywords.length > 0;
  const visibleKeywords = showAllKeywords
    ? scope.keywords
    : scope.keywords.slice(0, KEYWORD_COLLAPSED_LIMIT);

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
          ({scope.categories.length} categories, {scope.keywords.length} keywords)
        </span>
      </button>

      {open && (
        <div className="space-y-2 pl-5">
          {hasCats && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium">
                Categories ({scope.categories.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {scope.categories.map((tag) => (
                  <Tip
                    key={tag.value}
                    label={`${tag.chunkCount} chunks across ${tag.documentCount} document${tag.documentCount === 1 ? '' : 's'}`}
                  >
                    <Badge variant="secondary" className="text-xs">
                      {tag.value}
                      <span className="text-muted-foreground ml-1">({tag.chunkCount})</span>
                    </Badge>
                  </Tip>
                ))}
              </div>
            </div>
          )}

          {hasKws && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium">
                Keywords ({scope.keywords.length})
              </p>
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
      )}
    </div>
  );
}

interface ManageTabProps {
  documents: AiKnowledgeDocument[];
  onRefresh: () => void;
}

export function ManageTab({ documents, onRefresh }: ManageTabProps) {
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [rechunkingId, setRechunkingId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [lastSeededAt, setLastSeededAt] = useState<string | null>(null);
  const [metaTags, setMetaTags] = useState<MetaTagSummary | null>(null);
  const [showAllAppKeywords, setShowAllAppKeywords] = useState(false);
  const [showAllSystemKeywords, setShowAllSystemKeywords] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewData | null>(null);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [viewChunksId, setViewChunksId] = useState<string | null>(null);
  const [viewChunksName, setViewChunksName] = useState<string | null>(null);

  const fetchMetaTags = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_META_TAGS);
      if (!res.ok) return;
      const body = metaTagsResponseSchema.parse(await res.json());
      if (body.data?.app && body.data?.system) setMetaTags(body.data as unknown as MetaTagSummary);
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
      try {
        await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentRechunk(docId), { method: 'POST' });
        onRefresh();
      } finally {
        setRechunkingId(null);
      }
    },
    [onRefresh]
  );

  const handleDelete = useCallback(
    async (docId: string) => {
      setDeletingId(docId);
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(docId), {
          method: 'DELETE',
        });
        if (res.ok) {
          onRefresh();
          void fetchMetaTags();
          void fetchEmbeddingStatus();
        }
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

  const hasAppTags =
    metaTags !== null && (metaTags.app.categories.length > 0 || metaTags.app.keywords.length > 0);
  const hasSystemTags =
    metaTags !== null &&
    (metaTags.system.categories.length > 0 || metaTags.system.keywords.length > 0);

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

      {/* Built-in Agentic Design Patterns — separated from generic knowledge base */}
      <div className="bg-muted/30 space-y-3 rounded-lg border p-4">
        <div>
          <h3 className="text-sm font-medium">Built-in: Agentic Design Patterns</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Sunrise ships with a pre-chunked guide covering 21 agentic design patterns.{' '}
            <strong>Step 1:</strong> Load the patterns (no API key needed). <strong>Step 2:</strong>{' '}
            Generate embeddings to enable vector search (requires an embedding provider).
          </p>
        </div>
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
            <FieldHelp title="Load Agentic Design Patterns" ariaLabel="What does Load Patterns do?">
              <p>
                Inserts all pre-chunked content from the built-in <em>Agentic Design Patterns</em>{' '}
                guide into the database. The Learning Patterns page works immediately — no embedding
                provider needed.
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
                (a numerical fingerprint of its meaning). These vectors enable similarity search so
                the Advisor, Quiz, and Search can find relevant content.
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

      <DocumentUploadZone onUploadComplete={onRefresh} onPdfPreview={handlePdfPreview} />

      {/* Meta-tags in use */}
      {metaTags && (hasAppTags || hasSystemTags) && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-1.5">
            <Tag className="text-muted-foreground h-4 w-4" />
            <h3 className="text-sm font-medium">Meta-tags in use</h3>
            <FieldHelp
              title="Meta-tags in use"
              ariaLabel="About meta-tags"
              contentClassName="w-80 max-h-80 overflow-y-auto"
            >
              <p>
                This panel shows all category and keyword values found across your knowledge base
                chunks, separated by scope. Use it to check for consistency before uploading new
                documents.
              </p>
              <p className="mt-2">
                <strong>App knowledge</strong> contains your uploaded documents.{' '}
                <strong>System knowledge</strong> contains the built-in Agentic Design Patterns
                (read-only).
              </p>
              <p className="mt-2">
                <strong>Categories</strong> are best kept to a small, consistent set (5–15 values).
                Agents can be configured to only search specific categories, so inconsistent naming
                (e.g. &quot;sales&quot; vs &quot;Sales&quot; vs &quot;selling&quot;) means some
                content won&apos;t be found.
              </p>
              <p className="mt-2">
                <strong>Keywords</strong> are more forgiving — they boost search relevance
                additively, so having many unique keywords is fine. Duplicates or near-duplicates
                are less harmful here.
              </p>
              <p className="mt-2">
                Tags are completely <strong>free-form</strong> — you can use any values. But the
                trade-off is that there&apos;s no automatic normalisation. &quot;Sales&quot; and
                &quot;sales&quot; are treated as different values. Agree on naming conventions
                before bulk uploading.
              </p>
            </FieldHelp>
          </div>

          {hasAppTags && (
            <MetaTagSection
              title="App knowledge"
              scope={metaTags.app}
              defaultOpen
              showAllKeywords={showAllAppKeywords}
              onToggleKeywords={() => setShowAllAppKeywords((v) => !v)}
            />
          )}

          {hasSystemTags && (
            <MetaTagSection
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
                    <Tip label="Document category for filtering and agent scoping">
                      <span>Category</span>
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
                        {doc.category ? (
                          <Badge variant="secondary" className="text-xs">
                            {doc.category}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={style.variant}>{style.label}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right">{doc.chunkCount}</td>
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
                                  This document was loaded from the built-in Agentic Design Patterns
                                  data, which ships pre-chunked with optimised section boundaries.
                                  Rechunking would use the generic chunker and produce lower-quality
                                  splits.
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
    </div>
  );
}
