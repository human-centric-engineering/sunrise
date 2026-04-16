'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cpu, RefreshCw, Sprout } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { API } from '@/lib/api/endpoints';
import type { AiKnowledgeDocument, OrchestrationSettings } from '@/types/orchestration';

import { CompareProvidersModal } from './compare-providers-modal';
import { EmbeddingStatusBanner } from './embedding-status-banner';
import { DocumentUploadZone } from './document-upload-zone';
import { SearchTest } from './search-test';

const STATUS_STYLES: Record<
  string,
  { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
> = {
  pending: { variant: 'outline', label: 'Pending' },
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

interface KnowledgeViewProps {
  documents: AiKnowledgeDocument[];
}

export function KnowledgeView({ documents }: KnowledgeViewProps) {
  const router = useRouter();
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [rechunkingId, setRechunkingId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [lastSeededAt, setLastSeededAt] = useState<string | null>(null);

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  const fetchEmbeddingStatus = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDING_STATUS);
      if (!res.ok) return;
      const body = (await res.json()) as { data?: EmbeddingStatus };
      if (body.data) setEmbeddingStatus(body.data);
    } catch {
      // Silently ignore — status is supplementary
    }
  }, []);

  const fetchLastSeededAt = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS);
      if (!res.ok) return;
      const body = (await res.json()) as { data?: OrchestrationSettings };
      if (body.data?.lastSeededAt) setLastSeededAt(body.data.lastSeededAt as unknown as string);
    } catch {
      // Silently ignore — supplementary info
    }
  }, []);

  useEffect(() => {
    void fetchEmbeddingStatus();
    void fetchLastSeededAt();
  }, [fetchEmbeddingStatus, fetchLastSeededAt]);

  const handleSeed = useCallback(async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEED, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setSeedError(body?.error?.message ?? `Load failed (${res.status})`);
        return;
      }
      refresh();
      void fetchEmbeddingStatus();
      void fetchLastSeededAt();
    } catch {
      setSeedError('Network error — could not reach the server.');
    } finally {
      setSeeding(false);
    }
  }, [refresh, fetchEmbeddingStatus, fetchLastSeededAt]);

  const handleEmbed = useCallback(async () => {
    setEmbedding(true);
    setEmbedError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBED, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setEmbedError(body?.error?.message ?? `Embedding failed (${res.status})`);
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
        refresh();
      } finally {
        setRechunkingId(null);
      }
    },
    [refresh]
  );

  const hasChunks = embeddingStatus !== null && embeddingStatus.total > 0;
  const hasProvider = embeddingStatus?.hasActiveProvider ?? false;
  const allEmbedded =
    embeddingStatus !== null && embeddingStatus.total > 0 && embeddingStatus.pending === 0;
  const embedDisabled = embedding || !hasChunks || !hasProvider || allEmbedded;

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
            Sunrise ships with a pre-chunked guide covering 21 agentic design patterns. Load them to
            populate the Learning Patterns page, then optionally generate embeddings to enable
            vector search for the Advisor, Quiz, and Search.
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
              contentClassName="w-80"
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

      <DocumentUploadZone onUploadComplete={refresh} />

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
                      <td className="px-4 py-2 font-medium">{doc.name}</td>
                      <td className="px-4 py-2">
                        <Badge variant={style.variant}>{style.label}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right">{doc.chunkCount}</td>
                      <td className="text-muted-foreground px-4 py-2 text-xs">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {isSeeded ? (
                          <span className="inline-flex items-center gap-1">
                            <Badge variant="outline" className="text-xs">
                              Pre-chunked
                            </Badge>
                            <FieldHelp title="Pre-chunked" ariaLabel="Why can't this be rechunked?">
                              <p>
                                This document was loaded from the built-in Agentic Design Patterns
                                data, which ships pre-chunked with optimised section boundaries.
                                Rechunking would use the generic chunker and produce lower-quality
                                splits.
                              </p>
                              <p className="mt-2">
                                To refresh this data, use the{' '}
                                <strong>Load Agentic Design Patterns</strong> button above (it will
                                skip if already loaded).
                              </p>
                            </FieldHelp>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
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
                            <FieldHelp title="Rechunk" ariaLabel="What does Rechunk do?">
                              <p>
                                Re-splits this document into chunks and regenerates all embeddings
                                from scratch. Useful if the chunking strategy has been updated or if
                                the embedding model has changed — the new vectors may capture
                                meaning more accurately, improving search results.
                              </p>
                            </FieldHelp>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SearchTest />

      <CompareProvidersModal open={compareOpen} onOpenChange={setCompareOpen} />
    </div>
  );
}
