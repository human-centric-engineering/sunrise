# Knowledge Builder — Gotchas

## PDFs Require Two-Step Flow

PDFs cannot be uploaded directly like text/markdown. They require:

1. `previewDocument()` — extracts text, creates document with `pending_review` status
2. `confirmPreview()` — admin reviews/corrects text, then confirms to trigger chunking

Attempting to upload a PDF without the preview step will fail.

## Embeddings Are Not Auto-Generated

Uploading a document creates chunks but does **not** generate embeddings. You must explicitly call:

```
POST /api/v1/admin/orchestration/knowledge/embed
```

Without embeddings, vector search returns **no results**. This is the most common setup mistake.

## Category Cannot Be Changed After Chunking

The `category` is set at upload time (via parameter or metadata comment). Once the document is chunked, the category is baked into each chunk and cannot be changed without re-uploading the document.

## Empty knowledgeCategories = Search All

If an agent's `knowledgeCategories` array is **empty**, it searches ALL categories (no filtering). This is often not what you want — set explicit categories to scope results.

## Rechunk Is Blocked During Processing

Calling rechunk on a document with status `processing` returns a 409 `ConflictError`. Wait for the document to reach `ready` or `failed` status before rechunking.

## Embedding Provider Must Support Embeddings

Not all LLM providers support embeddings. Specifically:

- **Anthropic does NOT offer embedding models** — don't try to use it
- **Voyage AI** is recommended for free tier
- **OpenAI** `text-embedding-3-small` works too
- The provider must have at least one model with embedding capability

## Chunk Types Are Content-Classified, Not Category

The chunker classifies chunk types (e.g., `pattern_overview`, `implementation`, `example`) based on content analysis. These are useful for filtered search but are **separate from** the document category. Don't confuse the two:

- `category` = user-assigned topic grouping (e.g., "product-docs", "faq")
- `chunkType` = auto-classified content type (e.g., "implementation", "example")

## URL Fetch Has SSRF Protection

`fetchDocumentFromUrl` validates URLs against SSRF attacks — it blocks private IPs, localhost, and internal network addresses. This is intentional security, not a bug.

## Seeding Is Idempotent But Embedding Is Not

`seedChunks()` uses `chunkKey` for upsert — safe to run multiple times. But `POST /knowledge/embed` will re-embed chunks that already have embeddings if the provider or model has changed. This is usually fine but costs money.

## Hybrid Search Key Is `bm25Weight`, Not `keywordWeight`

A silent footgun. The settings JSON only honours the documented `SearchConfig` keys (`vectorWeight`, `bm25Weight`, `hybridEnabled`, `keywordBoostWeight`). Anything else is dropped on read. Setting `keywordWeight: 0.3` therefore has no effect — the resolver falls back to defaults and the admin sees vector-only behaviour. Check existing rows when migrating older config blobs.

## Vector-Only Mode Is The Default

`hybridEnabled: false` (or unset) keeps the legacy vector-only path with a small `keywordBoostWeight` (-0.02) for keyword-matching chunks. Turning on hybrid is a single-field flip but it changes the score scale — re-tune `vectorWeight` / `bm25Weight` if rankings shift unexpectedly after enabling.

## Semantic Chunking Is Opt-In And Failure-Safe

`semantic-chunker.ts` is a quality upgrade, not the default. The caller falls back to the structural splitter if the semantic chunker throws or returns empty (e.g. provider unreachable, text too short). Never block ingest on a semantic-chunking failure — the structural path is the safety net.

## Embedding Model Resolution Is Dynamic

There is no hardcoded "the embedding model" — `lib/orchestration/llm/embedding-models.ts` reads from DB-backed `AiProviderModel` rows tagged with `embedding` capability. Multiple embedding providers can coexist; the resolver picks one. Forks that ship with no embedding model registered will see `POST /knowledge/embed` fail until an embedding-capable model is activated.
