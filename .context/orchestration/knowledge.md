# Agent Orchestration — Knowledge Base

Document ingestion, chunking, embeddings, and vector search for the agent knowledge base. Implemented in `lib/orchestration/knowledge/` — platform-agnostic (no `next/*` imports).

**HTTP surface:** see [`admin-api.md`](./admin-api.md) — the "Knowledge Base" section covers the admin routes (`/search`, `/patterns`, `/patterns/:number`, `/documents`, `/documents/:id`, `/documents/:id/rechunk`, `/documents/:id/retry`, `/documents/:id/confirm`, `/documents/:id/chunks`, `/documents/:id/enrich-keywords`, `/documents/bulk`, `/documents/fetch-url`, `/seed`, `/tags`, `/embed`, `/embedding-status`, `/graph`, `/embeddings`).

## Embedding model & KB grouping

Two related concepts that determine where vectors live and how they're sized.

### Active embedding model

`AiOrchestrationSettings.activeEmbeddingModelId` is a nullable FK to `AiProviderModel`. When set, it's the single source of truth for which model the embedder uses and which dimension it produces; when null, the legacy provider-priority resolver runs (Voyage → local → OpenAI, all coerced to 1536).

`resolveActiveEmbeddingConfig()` in `embedder.ts` reads this FK, loads the matrix row, and validates four gates: row exists, `isActive: true`, `capabilities ∋ 'embedding'`, `dimensions > 0`. Failing any gate falls back to the legacy chain with a warning log — the picked model isn't usable, so we don't break embeddings outright.

**Switching models is a multi-step operation.** pgvector locks dimension at the column level, so:

1. Admin picks a new active model on the orchestration settings page.
2. Operator runs `npm run embeddings:reset` (drops + recreates the vector columns at the new dim, truncates `ai_knowledge_chunk` / `ai_knowledge_document` / `ai_message_embedding`, rebuilds HNSW indexes — **only those three tables**, never `db:reset`).
3. Operator re-uploads documents through the admin UI.

Skipping step 2 doesn't silently produce wrong results — search calls `assertActiveModelMatchesStoredVectors()` first, which samples one chunk's `embeddingDimension` and throws a directive error pointing at the reset script when it disagrees with the active model. The settings form surfaces the same notice inline after a dim-changing save.

**Provenance.** Every chunk and message-embedding row records the `embeddingModel`, `embeddingProvider`, and `embeddingDimension` that produced its vector. Don't infer dim from model id — matryoshka-truncated `text-embedding-3-large` at 1536 shares the model id with native 3072 but is a different vector space.

### Knowledge bases

`AiKnowledgeBase` is a grouping above documents. Every `AiKnowledgeDocument.knowledgeBaseId` is required; a seeded `kb_default` row catches uploads that don't specify one (production code references `DEFAULT_KNOWLEDGE_BASE_ID` from `document-manager.ts`).

Today the system is single-corpus — every document goes to `kb_default`, the picker UI is intentionally deferred. The model exists now so the future "per-KB embedding model" feature is a non-breaking additive change (add `embeddingSpaceId` to `AiKnowledgeBase`, route writes by space, partition chunks by physical table per dim) rather than a schema refactor. Don't build the per-KB UI until a real multi-corpus use case lands.

## Tags and Indexed Keywords

Two concepts that look similar but do different things. The current model:

| Concept              | Schema                                                                        | Purpose                                                                                      | Operator-editable?                                                                      |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Tags**             | `KnowledgeTag` + `AiKnowledgeDocumentTag` + `AiAgentKnowledgeTag` join tables | Access control. A `RESTRICTED` agent searches docs carrying any of its granted tags.         | Yes — Knowledge → Tags, upload zone, doc tags modal, agent form                         |
| **Indexed Keywords** | `AiKnowledgeChunk.keywords` (comma-separated string per chunk)                | BM25 ranking hints. Affects _how_ a chunk ranks for a query; never affects _who_ can see it. | Indirectly — via metadata comments in markdown, or via the Enrich Keywords admin action |

> **History.** A third "Categories" concept (`AiKnowledgeDocument.category`,
> `AiKnowledgeChunk.category`, `AiAgent.knowledgeCategories`) used to be the
> primary access-scoping mechanism. It was superseded by Tags in Phase 1
> (knowledge-access-control feature) and dropped entirely in Phase 6 —
> columns, validation schemas, search filters, the `/meta-tags` aggregator,
> and the backfill script all gone. The backup-bundle schema still accepts
> the field on the wire (older v1 bundles still ship it) but it's ignored
> on the write side.

### Tags

Managed taxonomy. Each tag has a slug (stable cross-environment key), a name, and an optional description. Applied to documents at upload time via the upload zone's Tags picker, or after upload via the doc row's tags modal. Granted to agents on the agent form's Knowledge Access section.

The resolver (`resolveAgentDocumentAccess` in `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts`) maps an agent's `knowledgeAccessMode` to an effective doc set:

- `full` → no filter; all docs.
- `restricted` → (docs explicitly granted) ∪ (docs carrying any granted tag) ∪ (system-scoped seed docs).

Tags have no required semantic meaning — they're labels. "Internal", "HR-confidential", "Onboarding" are all valid. Operators can create tags inline from the upload zone (type a non-matching name → "Create '…'" row).

**Built-in `agentic-design-patterns` tag.** When `seedChunks` loads the bundled patterns reference, it also creates a tag with slug `agentic-design-patterns` and grants it to the seeded `pattern-advisor` and `quiz-master` system agents (both run in `restricted` mode out of the box). The grant is created bidirectionally — the agent seeds also apply the tag if the patterns are already loaded — so this works regardless of whether the operator loads the patterns or runs the prisma seeds first. Pre-existing installs whose system agents are still on the `full` default get promoted to `restricted` automatically, but only when no admin customization is detected (no doc grants and no tag grants on the agent); any sign of customization is treated as the admin owning that agent's scope.

**Tag deletion safety.** When a tag is granted to one or more agents, `DELETE /knowledge/tags/:id` returns 409 unconditionally and includes the agents in `details.agents` — `?force=true` does not bypass this guard. The operator must remove the grant from each agent first. Tag deletion only force-deletes through when the tag is only linked to documents (where strip-on-delete is safe).

### Indexed Keywords

Per-chunk BM25 hints. Lives in `chunk.keywords` as a comma-separated string. Postgres maintains a generated `searchVector` column = `to_tsvector('english', content || ' ' || keywords)` indexed with a GIN index, used by the hybrid-search path (`search.ts:runHybridSearch`). The blended score is `vectorWeight × vector_score + bm25Weight × keyword_score`.

**Important: BM25 indexes the content even when keywords is NULL.** Keywords are a precision dial, not the primary lexical signal. Most uploads have NULL keywords and search still works.

Two sources today:

1. **Markdown metadata comments** — `<!-- metadata: keywords="retry,backoff,timeout" -->` anywhere in a markdown doc. The chunker (`chunker.ts:parseMetadataComments`) reads these. **Only markdown is parsed this way** — DOCX, PDF, EPUB, and CSV uploads do not pick up metadata comments.
2. **Enrich Keywords admin action** — `POST /knowledge/documents/:id/enrich-keywords` (see `lib/orchestration/knowledge/keyword-enricher.ts`). Runs an LLM over each chunk and writes 3–8 keyword phrases. Surfaced as a per-row button on the Manage tab. Costs are logged via `cost-tracker.ts`.

The Manage tab's _Indexed keywords_ panel is a read-only diagnostic. It aggregates distinct keyword values across chunks so operators can spot duplicates / typos that hurt ranking.

## Module Layout

| File                  | Exports                                                                                                                                 | Purpose                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `document-manager.ts` | `uploadDocument`, `uploadDocumentFromBuffer`, `previewDocument`, `confirmPreview`, `deleteDocument`, `rechunkDocument`, `listDocuments` | Full document lifecycle: upload, preview, confirm, delete, rechunk, list                                                           |
| `search.ts`           | `searchKnowledge`, `getPatternDetail`, `listPatterns`                                                                                   | Vector + keyword search; single-pattern lookup; pattern list for explorer                                                          |
| `seeder.ts`           | `seedChunks`, `embedChunks`                                                                                                             | Idempotent seeder for the "Agentic Design Patterns" doc; embedding backfill                                                        |
| `chunker.ts`          | `chunkMarkdownDocument(content, name, documentId?) → Promise<Chunk[]>`, `chunkCsvDocument`, `parseMetadataComments`                     | Markdown / DOCX / EPUB / confirmed-PDF → chunks. **Async** because generic sections route through the semantic chunker (see below) |
| `semantic-chunker.ts` | `chunkBySemanticBreakpoints(text, options?)`, `splitSentences(text)`                                                                    | Embedding-similarity splitter for generic prose. Called by `chunker.ts` when a section has no explicit headings                    |
| `embedder.ts`         | `embedText`, `embedBatch`                                                                                                               | Generates embeddings for text and chunk batches                                                                                    |
| `url-fetcher.ts`      | `fetchDocumentFromUrl`                                                                                                                  | Fetches documents from URLs with SSRF protection and size limits                                                                   |
| `parsers/`            | `parseDocument`, `requiresPreview`                                                                                                      | Multi-format parsing: TXT, EPUB, DOCX, PDF (see [document-ingestion.md](./document-ingestion.md))                                  |

## Quick Start

```typescript
import {
  uploadDocument,
  uploadDocumentFromBuffer,
  previewDocument,
  confirmPreview,
} from '@/lib/orchestration/knowledge/document-manager';
import { searchKnowledge, getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';

// Upload text content (admin flow — content is a string)
const doc = await uploadDocument(markdownContent, 'react-patterns.md', userId);

// To scope agent access, apply tags via the upload zone or the doc tags
// modal and grant them on the agent form. See "Tags and Indexed Keywords"
// above.

// Upload binary (EPUB/DOCX) — parsed then chunked automatically
const doc3 = await uploadDocumentFromBuffer(epubBuffer, 'book.epub', userId);

// Upload PDF (requires preview → confirm flow)
const preview = await previewDocument(pdfBuffer, 'report.pdf', userId);
// Admin reviews preview.extractedText, optionally corrects it, then:
const confirmed = await confirmPreview(preview.document.id, userId, correctedText);

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

**Optional fields** the upload zone sends with the multipart body:

- `name` — overrides the filename-derived display name. Stored as `AiKnowledgeDocument.name`.
- `tagIds[]` — repeated form field; each id is applied to the new document via the `AiKnowledgeDocumentTag` join table. The upload zone's tag picker supports inline-create when an operator types a non-matching name.

**Route details:**

- **Multipart only** (`multipart/form-data`), `file` field + optional `name`, `tagIds[]`
- **50 MB max** (`MAX_UPLOAD_BYTES` in the route)
- **Extension whitelist**: `.md`, `.markdown`, `.txt`, `.epub`, `.docx`, `.pdf`
- MIME type is advisory — the extension is the source of truth
- Text formats also have line-count (100k) and line-length (10k chars) guards
- Returns the created document at 201 with the standard response envelope
- PDFs return a preview object with `requiresConfirmation: true` instead

Knowledge documents are **not per-user scoped**. `uploadedBy` is stored for audit, but GET / DELETE / rechunk work on any document regardless of which admin created it.

## Chunking Strategy

`chunkMarkdownDocument()` routes work by the structure of the input:

| Section shape                                     | Path                             | What happens                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `## N. Pattern Name` (seeded design-patterns doc) | `chunkPatternSection`            | Split on `###` subheadings; the author's heading layout is authoritative. Each subsection becomes one chunk, sized to land in the 50–800 token range.                                                                          |
| Generic with `## ` / `### ` headings              | `chunkGenericSection` structural | Split on `###` subheadings; size-normalise via the tier fallback (paragraphs → lines → sentences → char-window). Author's headings drive the boundaries.                                                                       |
| Generic without subheadings                       | `chunkGenericSection` semantic   | Route through `chunkBySemanticBreakpoints()` from `semantic-chunker.ts`. Every sentence is embedded, adjacent-sentence cosine distances are computed, and chunk boundaries land at the 75th-percentile-largest distance jumps. |

**Why two paths.** When an author has typed `## Section A`, that's an explicit semantic boundary — better than any embedding heuristic. When the content is unstructured (PDF text, raw transcripts, prose-only markdown) the embedding-based splitter avoids mid-sentence cuts that the structural tier fallback can produce.

**Semantic chunker details:**

- One embedding call per sentence via `embedBatch` — uses the configured embedding provider (same one used for chunk-storage embeddings; see `embedder.ts`).
- `breakpointPercentile` defaults to **75** (matches LangChain's `SemanticChunker`). Higher = fewer breakpoints / larger chunks.
- Size guardrails (`minTokens=50` / `maxTokens=800`) merge tiny groups into neighbours and sub-split oversized topic groups.
- Falls back to the structural splitter when the embedder throws, when there are fewer than 4 sentences, or when sentence segmentation produces nothing. Semantic chunking is a quality upgrade, never a hard dependency — a document never fails to ingest because the embedder is unreachable.
- Sentence segmentation is regex-based with a small abbreviation guard (`Inc.`, `e.g.`, `etc.`, …) so "Acme Inc. is a corporation" stays one sentence.

**Default `chunkType`** for generic content is `'text'` — not `'pattern_section'`, which is reserved for the seeded design-patterns doc and any document the author marked up with the pattern heading convention. Heading-driven labels still apply when the heading text matches: `glossary`, `composition_recipe`, `selection_guide`, `cost_reference`, `context_engineering`, `emerging_concepts`, `ecosystem`, `pattern_overview`.

**Section titles** for generic content without headings are derived from the chunk's first sentence (≤80 chars). Authored headings take precedence when present.

## In-document metadata comments

Markdown authors can embed per-section keyword hints anywhere in a document using HTML comments:

```markdown
<!-- metadata: keywords="pricing,discounts,negotiation" -->

## Section heading

Content here inherits the metadata above…
```

`parseMetadataComments(content)` (exported from `chunker.ts`) extracts these into a `Record<string, string>`. The only key the chunker reads today is `keywords`; comma-separated values, optionally double-quoted when the value itself contains commas.

**Only markdown.** DOCX, PDF, EPUB, and CSV uploads do not pick up metadata comments — their parser pipelines go directly to chunking without the markdown comment-stripping pass. To set keywords on non-markdown uploads, use the **Enrich Keywords** admin action (below).

## Indexed-keyword discovery

`listMetaTags()` returns a `MetaTagSummary` with distinct keyword values in use, grouped by document scope (`app` vs `system`), plus chunk and document counts for each. Surfaced by the Manage tab as the **Indexed keywords** diagnostic panel.

```typescript
interface MetaTagSummary {
  app: ScopedMetaTags; // user-uploaded documents
  system: ScopedMetaTags; // built-in seeded patterns (read-only)
}

interface ScopedMetaTags {
  keywords: MetaTagEntry[]; // { value, chunkCount, documentCount }
}
```

The admin route `GET /knowledge/meta-tags` exposes this. Agent scoping is **not** done here — it lives on the `KnowledgeTag` model and `resolveAgentDocumentAccess` (see "Tags, Indexed Keywords, and Categories" at the top of this doc).

## Enriching keywords post-upload

`POST /knowledge/documents/:id/enrich-keywords` runs an LLM over each chunk of a document and writes 3–8 keyword phrases into `chunk.keywords`. Implemented in `lib/orchestration/knowledge/keyword-enricher.ts`. Surfaced as a per-row button on the Manage tab between Rechunk and Delete. Use it when an uploaded doc isn't ranking for queries whose vocabulary differs from the literal content (e.g., content says "exponential backoff after request failure" but operators ask about "retry policy" or "circuit breaker").

Cost is logged via `cost-tracker.ts` under operation `knowledge.enrich_keywords` and shows up in the admin Costs view. The LLM call uses the configured `chat` default model (`getDefaultModelForTask('chat')`); operators can switch to a cheap utility model by editing `AiOrchestrationSettings.defaultModels.chat`.

## Search

`searchKnowledge(query, filters?, limit?, threshold?)` ranks knowledge-base chunks via pgvector cosine distance, with two modes selected by `searchConfig.hybridEnabled` on the orchestration settings singleton. Filters support `chunkType`, `patternNumber`, `section`, `documentId`, and `scope` (see `knowledgeSearchSchema` in `lib/validations/orchestration.ts` for the full enum).

Results are ranked chunks with their parent document metadata — the admin search route (`POST /knowledge/search`) surfaces this directly. POST (not GET) because the filter payload can contain arbitrary text and we don't want query bodies in URL logs.

### Vector-only mode (default)

Cosine distance via pgvector's `<=>` operator with a small additive **keyword boost** for chunks whose `keywords` (-0.05) or `content` (-0.02) match `plainto_tsquery(query)`. The boost magnitude is admin-tunable via `searchConfig.keywordBoostWeight`. Result rows include a single `similarity` score.

### Hybrid mode (BM25-flavoured + vector)

Opt-in via `searchConfig.hybridEnabled = true` on `AiOrchestrationSettings`. Designed for domain-specific terminology where exact-term recall matters — legal ("Section 21 notice"), regulatory ("ELM Countryside Stewardship"), financial ("affordability stress test at 3% above SVR"), medical, trade. Vector embeddings systematically miss these; BM25-style lexical scoring catches them.

Ranking formula:

```
vector_score   = max(0, 1 - cosine_distance)
keyword_score  = ts_rank_cd(searchVector, plainto_tsquery('english', q), 32)
final_score    = vectorWeight × vector_score + bm25Weight × keyword_score
```

Results are ordered by `final_score DESC`. The cosine-distance threshold continues to gate candidates so the semantic recall floor is preserved across both modes.

`ts_rank_cd` is PostgreSQL's cover-density ranker — a **BM25 proxy**, not true BM25. True BM25 in pure SQL needs corpus-level avgdl + per-term IDF computed at query time, which is fragile, slow, and pulls in extension territory (`pg_search`, `paradedb`) that would be infrastructure churn we don't need at current corpus sizes. Normalisation mode `32` (`rank/(rank+1)`) bounds output to `[0, 1)` so the blend formula is well-scaled.

When hybrid is enabled, result rows include three additional fields — `vectorScore`, `keywordScore`, `finalScore` — which the Explore tab renders as a three-segment score breakdown. The legacy `keywordBoostWeight` is intentionally **ignored** in hybrid mode; tune `bm25Weight` instead.

#### Storage: the `searchVector` column

The hybrid path queries an indexed tsvector column on `ai_knowledge_chunk`:

```sql
ALTER TABLE ai_knowledge_chunk
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(keywords, ''))
  ) STORED;
CREATE INDEX idx_ai_knowledge_chunk_search_vector
  ON ai_knowledge_chunk USING GIN ("searchVector");
```

Postgres auto-populates the column on `INSERT`/`UPDATE` — application code (chunker, embedder, document-manager) is **not** changed. The column is declared as `Unsupported("tsvector")` in the Prisma schema since Prisma can't model `GENERATED` columns; the migration owns the SQL.

### Smoke testing

`scripts/smoke/knowledge-hybrid-search.ts` (`npm run smoke:hybrid-search`) seeds three scoped chunks, runs both SQL branches against real Postgres, and asserts `ts_rank_cd` returns a non-zero score for an exact-term query. Use this when touching `search.ts` or the `searchVector` migration.

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

**Provider resolution.** `resolveProvider()` in `embedder.ts` first checks `AiOrchestrationSettings.activeEmbeddingModelId` via `resolveActiveEmbeddingConfig()`; an operator-picked model wins, with model id + dim + `schemaCompatible` flag coming from the `AiProviderModel` row and `baseUrl` + `apiKey` from the matching `AiProviderConfig`. When no model is picked (or the picked row fails the validity gates), it falls back to the legacy priority chain: (1) Voyage AI; (2) local provider (e.g. Ollama); (3) OpenAI-compatible with custom `baseUrl`; (4) OpenAI API directly via `OPENAI_API_KEY`. The fallback always reports 1536-dim — every branch is configured to produce that. See "Active embedding model" at the top of this doc for the switching workflow.

**Idempotency:** `/embed` only touches chunks with `NULL` embeddings, so it is safe to call repeatedly. A completed run is a cheap no-op.

**UI pairing:** See [Knowledge Base UI — Seed & Embed](../admin/orchestration-knowledge-ui.md#seed--embed-two-step-flow) for the two-step "Load patterns → Generate embeddings" flow that consumes these endpoints.

## Anti-Patterns

**Don't** bypass `documentManager` for uploads — it owns the chunk/embedding write ordering. Direct `prisma.aiKnowledgeDocument.create` skips the chunker entirely and leaves an unsearchable document.

**Don't** add a "knowledge scope" check to the admin routes. Knowledge is a global asset by design — adding per-user scoping would fork the admin and runtime capability code paths.

**Don't** rely on `file.type` (the MIME header) for security — browsers frequently omit it for `.md` files. The extension check is the load-bearing validation.

**Don't** import from `next/*` inside `lib/orchestration/knowledge/` — keep it platform-agnostic. HTTP wrapping lives in `app/api/v1/admin/orchestration/knowledge/*`.

**Don't** change `activeEmbeddingModelId` and skip `npm run embeddings:reset`. Search will refuse to run (`assertActiveModelMatchesStoredVectors` throws) and the message-embedder will crash on the `::vector` cast; both are intentional fail-fast paths, not bugs.

**Don't** run `npm run db:reset` to "fix" a dim mismatch — it wipes users, sessions, settings, providers, and every other table. `npm run embeddings:reset` is narrowly scoped to the three embedding/chunk/document tables.

## Related Documentation

- [Document Ingestion Pipeline](./document-ingestion.md) — multi-format parser architecture, PDF preview flow
- [Admin API — Knowledge Base](./admin-api.md) — HTTP surface for all routes
- [Capabilities](./capabilities.md) — `search_knowledge_base` and `get_pattern_detail` built-in tools that consume this layer
- [Streaming Chat](./chat.md) — `buildContext` uses `getPatternDetail` for locked-context injection
- [Knowledge Base UI](../admin/orchestration-knowledge-ui.md) — admin interface documentation
- `prisma/schema.prisma` — `AiKnowledgeBase`, `AiKnowledgeDocument`, `AiKnowledgeChunk`, `AiMessageEmbedding` models
- `scripts/embeddings-reset.ts` — narrowly-scoped reset script invoked by `npm run embeddings:reset`
- `lib/validations/orchestration.ts` — `knowledgeSearchSchema`, `listDocumentsQuerySchema`, `confirmDocumentPreviewSchema`
