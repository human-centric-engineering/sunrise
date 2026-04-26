# Agent Orchestration — Knowledge Base

Document ingestion, chunking, embeddings, and vector search for the agent knowledge base. Implemented in `lib/orchestration/knowledge/` — platform-agnostic (no `next/*` imports).

**HTTP surface:** see [`admin-api.md`](./admin-api.md) — the "Knowledge Base" section covers the admin routes (`/search`, `/patterns`, `/patterns/:number`, `/documents`, `/documents/:id`, `/documents/:id/rechunk`, `/documents/:id/retry`, `/documents/:id/confirm`, `/documents/:id/chunks`, `/documents/bulk`, `/documents/fetch-url`, `/seed`, `/meta-tags`, `/embed`, `/embedding-status`, `/graph`).

## Module Layout

| File                  | Exports                                                                                                                                                 | Purpose                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `document-manager.ts` | `uploadDocument`, `uploadDocumentFromBuffer`, `previewDocument`, `confirmPreview`, `deleteDocument`, `rechunkDocument`, `listDocuments`, `listMetaTags` | Full document lifecycle: upload, preview, confirm, delete, rechunk, list                              |
| `search.ts`           | `searchKnowledge`, `getPatternDetail`, `listPatterns`                                                                                                   | Vector + keyword search; single-pattern lookup; pattern list for explorer                             |
| `seeder.ts`           | `seedChunks`, `embedChunks`                                                                                                                             | Idempotent seeder for the "Agentic Design Patterns" doc; embedding backfill                           |
| `chunker.ts`          | `chunkMarkdownDocument(content, name, documentId?)`, `parseMetadataComments`                                                                            | Markdown → chunks with type classification; optional `documentId` prefix prevents chunkKey collisions |
| `embedder.ts`         | `embedText`, `embedBatch`                                                                                                                               | Generates embeddings for text and chunk batches                                                       |
| `url-fetcher.ts`      | `fetchDocumentFromUrl`                                                                                                                                  | Fetches documents from URLs with SSRF protection and size limits                                      |
| `parsers/`            | `parseDocument`, `requiresPreview`                                                                                                                      | Multi-format parsing: TXT, EPUB, DOCX, PDF (see [document-ingestion.md](./document-ingestion.md))     |

## Quick Start

```typescript
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
  confirmPreview,
  listMetaTags,
} from '@/lib/orchestration/knowledge/document-manager';
import { searchKnowledge, getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';

// Upload text content (admin flow — content is a string)
const doc = await uploadDocument(markdownContent, 'react-patterns.md', userId);

// Upload with explicit category (overrides any in-document metadata)
const doc2 = await uploadDocument(markdownContent, 'playbook.md', userId, 'sales');

// Upload binary (EPUB/DOCX) — parsed then chunked automatically
const doc3 = await uploadDocumentFromBuffer(epubBuffer, 'book.epub', userId, 'reference');

// Upload PDF (requires preview → confirm flow)
const preview = await previewDocument(pdfBuffer, 'report.pdf', userId);
// Admin reviews preview.extractedText, optionally corrects it, then:
const confirmed = await confirmPreview(preview.document.id, userId, correctedText, 'reports');

// List all category and keyword values across the knowledge base
const tags = await listMetaTags();
// → { app: { categories: [...], keywords: [...] }, system: { categories: [...], keywords: [...] } }

// Vector search
const results = await searchKnowledge(
  'chain of thought reasoning',
  { chunkType: 'pattern_overview' },
  10
);

// Single pattern lookup
const pattern = await getPatternDetail(3);

// Seed (idempotent — see below)
await seedChunks('prisma/seeds/data/chunks/chunks.json');
```

## Document Lifecycle

`AiKnowledgeDocument.status` moves through five states:

```
pending → processing → ready
              ↘ failed
    ↘ pending_review → (confirm) → processing → ready
                                        ↘ failed
```

| Status           | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `pending`        | Row created, chunking not yet started. Rare — most uploads transition out of this state synchronously. |
| `pending_review` | PDF uploaded — extracted text needs admin review/correction before chunking proceeds.                  |
| `processing`     | Chunker is running. `rechunk` is blocked in this state (409 `ConflictError` from the admin route).     |
| `ready`          | All chunks and embeddings are persisted. Searchable.                                                   |
| `failed`         | Chunking or embedding threw. The document row stays in place for inspection / retry via rechunk.       |

## Upload

The upload route (`POST /knowledge/documents`) supports multiple formats with format-specific processing pipelines. See [document-ingestion.md](./document-ingestion.md) for full parser details.

**Supported formats:**

| Format | Extensions                 | Pipeline                                 | Max Size |
| ------ | -------------------------- | ---------------------------------------- | -------- |
| Text   | `.md`, `.markdown`, `.txt` | Read as string → chunk → embed → store   | 50 MB    |
| EPUB   | `.epub`                    | Parse → chunk → embed → store            | 50 MB    |
| DOCX   | `.docx`                    | Parse → chunk → embed → store            | 50 MB    |
| PDF    | `.pdf`                     | Parse → preview → admin confirms → chunk | 50 MB    |

**Category resolution** (priority order):

1. Explicit `category` parameter (from the upload form)
2. Document-level `<!-- metadata: category=... -->` comment (parsed by `extractDocumentCategory`)
3. `null` — no category assigned

When a document-level category is resolved, it propagates to any chunks that don't have their own category from section-level metadata comments.

**Route details:**

- **Multipart only** (`multipart/form-data`), `file` field + optional `category` field
- **50 MB max** (`MAX_UPLOAD_BYTES` in the route)
- **Extension whitelist**: `.md`, `.markdown`, `.txt`, `.epub`, `.docx`, `.pdf`
- MIME type is advisory — the extension is the source of truth
- Text formats also have line-count (100k) and line-length (10k chars) guards
- Returns the created document at 201 with the standard response envelope
- PDFs return a preview object with `requiresConfirmation: true` instead

Knowledge documents are **not per-user scoped**. `uploadedBy` is stored for audit, but GET / DELETE / rechunk work on any document regardless of which admin created it.

## Categories and Meta-Tags

Documents and chunks support **category** and **keywords** metadata. Categories are a first-class field on `AiKnowledgeDocument` (with a database index) and on each `AiKnowledgeChunk`. Keywords are stored as comma-separated strings on chunks.

### In-document metadata comments

Authors can embed metadata in their markdown using HTML comments:

```markdown
<!-- metadata: category=sales, keywords="pricing,discounts,negotiation" -->

## Section heading

Content here inherits the metadata above...
```

`parseMetadataComments(content)` (exported from `chunker.ts`) extracts these into a `Record<string, string>`. Supported tags: `category`, `keywords`. Tags are free-form — there is no fixed taxonomy. Case-sensitive: `Sales` ≠ `sales`.

### Meta-tag discovery

`listMetaTags()` returns a `MetaTagSummary` with all distinct category and keyword values in use, grouped by document scope (`app` vs `system`), plus chunk and document counts for each. Used by the admin UI to show what tags exist (in separate collapsible sections) and power category autocomplete on the upload form (app categories only).

```typescript
interface MetaTagSummary {
  app: ScopedMetaTags; // user-uploaded documents
  system: ScopedMetaTags; // built-in seeded patterns (read-only)
}

interface ScopedMetaTags {
  categories: MetaTagEntry[]; // { value, chunkCount, documentCount }
  keywords: MetaTagEntry[];
}
```

The admin route `GET /knowledge/meta-tags` exposes this. Agent scoping uses `AiAgent.knowledgeCategories` (a string array) to filter which categories an agent can search.

## Search

`searchKnowledge(query, filters?, limit?, threshold?)` runs a hybrid cosine-similarity + keyword-boost search via pgvector. Filters support `chunkType`, `patternNumber`, `category`, `categories` (array), `section`, `documentId`, and `scope` (see `knowledgeSearchSchema` in `lib/validations/orchestration.ts` for the full enum).

Results are ranked chunks with their parent document metadata — the admin search route (`POST /knowledge/search`) surfaces this directly. POST (not GET) because the filter payload can contain arbitrary text and we don't want query bodies in URL logs.

`getPatternDetail(patternNumber)` is a specialized lookup that returns all chunks tagged with a given pattern number in source order — used by the admin `GET /knowledge/patterns/:number` route and by the `buildContext` path in the streaming chat handler. Returns 404 (via `NotFoundError` in the route) when no chunks exist.

## Rechunking

`rechunkDocument(id)` deletes the current chunks, re-runs the chunker + embedder, and writes fresh rows. Use it after:

- Improving `chunker.ts` (e.g. better markdown heading detection, new chunk type classification)
- Fixing a chunk classification bug for a specific document
- Changing the embedding model (future — currently fixed)

The admin route guards against double-rechunk: if the document is currently `status === 'processing'` it returns 409 `ConflictError` rather than racing.

## Seeder

`seedChunks(chunksJsonPath)` loads a pre-built chunks file and upserts a single canonical document — the "Agentic Design Patterns" reference that the built-in `get_pattern_detail` and `search_knowledge_base` capabilities rely on.

**The seeder is idempotent.** Safe to call on every deploy: if the "Agentic Design Patterns" document already exists, the seeder is a no-op. Don't wrap calls in existence checks — that's the seeder's job.

Seed file lives at `prisma/seeds/data/chunks/chunks.json`. The admin route (`POST /knowledge/seed`) resolves this via `path.join(process.cwd(), 'prisma/seeds/data/chunks/chunks.json')` and returns `{ seeded: true }` when the call completes.

## Embedding backfill

Chunks are written with `embedding: NULL` when no active embedding provider is configured at upload time (e.g. a dev environment without an `OPENAI_API_KEY`). Two admin endpoints close that loop without rechunking.

| Route                                                    | Method | Purpose                                                                     |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `/api/v1/admin/orchestration/knowledge/embed`            | `POST` | Backfill: finds every chunk where `embedding IS NULL` and embeds in batches |
| `/api/v1/admin/orchestration/knowledge/embedding-status` | `GET`  | Polling snapshot: `{ total, embedded, pending, hasActiveProvider }`         |

**Implementation:** `embedChunks()` in `seeder.ts` is the shared primitive — the seed flow also calls it after inserting chunks. Both routes rate-limit via `adminLimiter`. The `hasActiveProvider` flag on the status endpoint is `true` when either `AiProviderConfig` has an active row **or** `OPENAI_API_KEY` is set in env, so the admin UI can disable the "Generate Embeddings" button until at least one is configured.

**Provider priority:** `resolveProvider()` in `embedder.ts` selects the embedding provider in this order: (1) Voyage AI — best retrieval quality, free tier; (2) Local provider (e.g. Ollama) — cheaper/faster; (3) OpenAI-compatible with custom `baseUrl`; (4) OpenAI API directly via `OPENAI_API_KEY`. This chain is internal to the embedder — callers don't specify the provider.

**Idempotency:** `/embed` only touches chunks with `NULL` embeddings, so it is safe to call repeatedly. A completed run is a cheap no-op.

**UI pairing:** See [Knowledge Base UI — Seed & Embed](../admin/orchestration-knowledge-ui.md#seed--embed-two-step-flow) for the two-step "Load patterns → Generate embeddings" flow that consumes these endpoints.

## Anti-Patterns

**Don't** bypass `documentManager` for uploads — it owns the chunk/embedding write ordering. Direct `prisma.aiKnowledgeDocument.create` skips the chunker entirely and leaves an unsearchable document.

**Don't** add a "knowledge scope" check to the admin routes. Knowledge is a global asset by design — adding per-user scoping would fork the admin and runtime capability code paths.

**Don't** rely on `file.type` (the MIME header) for security — browsers frequently omit it for `.md` files. The extension check is the load-bearing validation.

**Don't** import from `next/*` inside `lib/orchestration/knowledge/` — keep it platform-agnostic. HTTP wrapping lives in `app/api/v1/admin/orchestration/knowledge/*`.

## Related Documentation

- [Document Ingestion Pipeline](./document-ingestion.md) — multi-format parser architecture, PDF preview flow
- [Admin API — Knowledge Base](./admin-api.md) — HTTP surface for all routes
- [Capabilities](./capabilities.md) — `search_knowledge_base` and `get_pattern_detail` built-in tools that consume this layer
- [Streaming Chat](./chat.md) — `buildContext` uses `getPatternDetail` for locked-context injection
- [Knowledge Base UI](../admin/orchestration-knowledge-ui.md) — admin interface documentation
- `prisma/schema.prisma` — `AiKnowledgeDocument`, `AiKnowledgeChunk` models
- `lib/validations/orchestration.ts` — `knowledgeSearchSchema`, `listDocumentsQuerySchema`, `confirmDocumentPreviewSchema`
