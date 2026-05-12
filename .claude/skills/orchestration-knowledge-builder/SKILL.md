---
name: orchestration-knowledge-builder
version: 1.0.0
description: |
  Expert knowledge base builder for Sunrise orchestration. Sets up document
  ingestion, chunking, embeddings, and vector search so agents can answer
  questions grounded in real data instead of hallucinating. Handles the full
  lifecycle: upload documents (MD, PDF, EPUB, DOCX), chunk, generate embeddings,
  and scope knowledge to specific agents. Use when agents need to search
  company docs, product information, FAQs, or any document corpus.

triggers:
  - 'set up knowledge base'
  - 'upload documents'
  - 'configure knowledge'
  - 'add knowledge'
  - 'knowledge base'
  - 'document ingestion'
  - 'rag setup'
  - 'agent needs to search documents'
  - 'ground agent in real data'
  - 'agent should know about our docs'
  - 'feed documents to agent'
  - 'agent keeps hallucinating facts'
  - 'connect agent to our documentation'

contexts:
  - 'lib/orchestration/knowledge/document-manager.ts'
  - 'lib/orchestration/knowledge/search.ts'
  - 'lib/orchestration/knowledge/chunker.ts'
  - 'lib/orchestration/knowledge/embedder.ts'
  - 'lib/orchestration/knowledge/seeder.ts'
  - 'lib/orchestration/knowledge/url-fetcher.ts'
  - 'lib/orchestration/knowledge/parsers/'
  - 'lib/orchestration/capabilities/built-in/search-knowledge.ts'
  - '.context/orchestration/knowledge.md'
  - '.context/orchestration/document-ingestion.md'
  - '.context/admin/orchestration-knowledge-ui.md'
  - 'prisma/seeds/data/chunks/'

mcp_integrations:
  context7:
    libraries:
      - zod: '/colinhacks/zod'

parameters:
  supported_formats: ['md', 'txt', 'csv', 'epub', 'docx', 'pdf']
  max_file_size_mb: 50
  default_top_k: 10
  default_similarity_threshold: 0.8
---

# Knowledge Builder Skill

## Mission

You set up knowledge bases for RAG-enabled agents in the Sunrise orchestration system. This covers document upload, chunking, embedding generation, vector search configuration, and agent scoping. Your job is to get documents searchable and properly scoped to the right agents.

## Document Lifecycle

```
pending → processing → ready
              ↘ failed
    ↘ pending_review → (confirm) → processing → ready
                                        ↘ failed
```

| Status           | Meaning                                           |
| ---------------- | ------------------------------------------------- |
| `pending`        | Row created, chunking not started                 |
| `pending_review` | PDF uploaded — needs admin review before chunking |
| `processing`     | Chunker running; rechunk blocked (409)            |
| `ready`          | Chunks and embeddings persisted; searchable       |
| `failed`         | Chunking/embedding error; retry via rechunk       |

## 6-Step Setup Process

### Step 1: Ensure an embedding-capable model is available

Embedding generation resolves through the embedding-model registry (`lib/orchestration/llm/embedding-models.ts`), which reads from DB-backed `AiProviderModel` rows tagged with `embedding` capability. Any active provider with at least one embedding-capable model works.

Common choices:

- **Voyage AI** (`providerType: "voyage"`, env `VOYAGE_API_KEY`) — free tier, query/document input-type optimisation.
- **OpenAI** (`providerType: "openai-compatible"`, env `OPENAI_API_KEY`) — `text-embedding-3-small` / `text-embedding-3-large`.
- **Local** (e.g. Ollama via OpenAI-compatible) — zero-cost dev option.

Create the provider (if not already present):

```
POST /api/v1/admin/orchestration/providers
{
  "name": "Voyage AI",
  "slug": "voyage",
  "providerType": "voyage",
  "apiKeyEnvVar": "VOYAGE_API_KEY",
  "isActive": true
}
```

Set the corresponding env var in `.env.local`. **Anthropic does not offer an embedding model** — pick a different provider for embeddings even if Anthropic is the chat provider. Fresh installs ship with no providers; the setup wizard or env-var detection registry surfaces what is wired.

### Step 2: Upload documents

**Text/Markdown** (direct upload):

```
POST /api/v1/admin/orchestration/knowledge/documents
Content-Type: multipart/form-data

file: <file>
category: "product-docs"  (optional)
```

Or programmatically:

```typescript
import { uploadDocument } from '@/lib/orchestration/knowledge/document-manager';

const doc = await uploadDocument(markdownContent, 'react-patterns.md', userId);
// With explicit category:
const doc2 = await uploadDocument(content, 'playbook.md', userId, 'sales');
```

**Binary formats** (EPUB, DOCX):

```typescript
import { uploadDocumentFromBuffer } from '@/lib/orchestration/knowledge/document-manager';

const doc = await uploadDocumentFromBuffer(buffer, 'book.epub', userId, 'reference');
```

**CSV** (row-atomic chunking — one chunk per row, batched in groups of 10 above 5,000 rows):

```typescript
const doc = await uploadDocumentFromBuffer(buffer, 'pricing.csv', userId, 'tariffs');
```

CSV runs through a separate `chunkCsvDocument` path inside `uploadDocumentFromBuffer` — each chunk's content is a pipe-joined `Header: Value | …` string from `csv-parser.ts`. This makes per-row retrieval atomic and avoids row-bleed across chunks.

**PDF** (two-step flow — preview then confirm):

```typescript
import { previewDocument, confirmPreview } from '@/lib/orchestration/knowledge/document-manager';

// Step 1: Preview — extracts text for review
const preview = await previewDocument(pdfBuffer, 'report.pdf', userId);

// Step 2: Admin reviews preview.extractedText, optionally corrects, then confirms
const confirmed = await confirmPreview(preview.document.id, userId, correctedText, 'reports');
```

**URL fetch** (with SSRF protection):

```
POST /api/v1/admin/orchestration/knowledge/documents/fetch-url
{
  "url": "https://example.com/docs/guide.md",
  "category": "external-docs"
}
```

### Step 3: Generate embeddings

Embeddings are **not** generated automatically on upload. You must trigger embedding generation:

```
POST /api/v1/admin/orchestration/knowledge/embed
```

This backfills embeddings for all chunks that don't have them yet. Check status:

```
GET /api/v1/admin/orchestration/knowledge/embedding-status
```

### Step 4: Configure search parameters

Search has two modes selected by the `hybridEnabled` flag on the `SearchConfig` JSON in the settings singleton.

**Vector-only mode** (`hybridEnabled: false` or unset — the default):

| Field                | Default | Description                                                 |
| -------------------- | ------- | ----------------------------------------------------------- |
| `vectorWeight`       | `1.0`   | Multiplier on cosine similarity                             |
| `keywordBoostWeight` | `-0.02` | Non-positive distance reduction for keyword-matching chunks |

**Hybrid mode** (`hybridEnabled: true`) — blends BM25-flavoured (`ts_rank_cd`) and vector scores:

| Field          | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| `vectorWeight` | `1.0`   | Multiplier on the vector similarity score                          |
| `bm25Weight`   | `1.0`   | Multiplier on the BM25-flavoured keyword score (range `0.1`–`2.0`) |

⚠️ The keyword-weight field is **`bm25Weight`**, not `keywordWeight`. Storing `keywordWeight` is a silent no-op — the resolver ignores unknown keys.

**Search call defaults** (function signature on `searchKnowledge`):

| Argument       | Default | Description                         |
| -------------- | ------- | ----------------------------------- |
| `limit` (topK) | `10`    | Number of results per search        |
| `threshold`    | `0.8`   | Minimum cosine similarity (0.0–1.0) |

Per-field fallback: a partial override (e.g. `{ hybridEnabled: true }` alone) inherits defaults for every field the admin did not set.

### Step 5: Scope knowledge to agents

Agents access the knowledge base via `knowledgeCategories` — a string array on the `AiAgent` record:

```
PATCH /api/v1/admin/orchestration/agents/{id}
{
  "knowledgeCategories": ["product-docs", "faq"]
}
```

- **Empty array** = agent searches ALL categories (no filtering)
- **Non-empty array** = agent only sees documents matching those categories

Categories are set at upload time and cannot be changed after chunking.

### Step 6: Enable search_knowledge_base capability

The `search_knowledge_base` capability is built-in (`isSystem: true`). Bind it to the agent:

```
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{
  "capabilityId": "<search_knowledge_base capability ID>",
  "isEnabled": true
}
```

Find the capability ID:

```
GET /api/v1/admin/orchestration/capabilities?slug=search_knowledge_base
```

## Supported Formats

| Format | Extensions                 | Pipeline                                          | Max Size |
| ------ | -------------------------- | ------------------------------------------------- | -------- |
| Text   | `.md`, `.markdown`, `.txt` | Read → chunk → embed → store                      | 50 MB    |
| CSV    | `.csv`                     | Parse → row-atomic chunk → embed → store          | 50 MB    |
| EPUB   | `.epub`                    | Parse → chunk → embed → store                     | 50 MB    |
| DOCX   | `.docx`                    | Parse → chunk → embed → store                     | 50 MB    |
| PDF    | `.pdf`                     | Parse → preview → confirm → chunk → embed → store | 50 MB    |

Parsers live in `lib/orchestration/knowledge/parsers/`. PDF parsing supports multiple backends; the per-file extension determines the pipeline.

## Category Resolution (priority order)

1. Explicit `category` parameter (from upload form or API)
2. Document-level `<!-- metadata: category=... -->` comment in the content
3. `null` — no category assigned

## Chunking

Two chunkers live in `lib/orchestration/knowledge/`:

**Structural chunker (`chunker.ts`)** — the default path for plain-text / Markdown / DOCX / EPUB / confirmed-PDF:

- Splits on `##` then `###` headers and merges/splits sections into the 50–800 token range
- Preserves section boundaries; classifies chunk types (e.g. `pattern_overview`, `implementation`, `example`)
- Tiered split fallback: paragraphs → lines → sentences → char-window so PDF prose (which `pdfjs-dist` extracts with `\n` line separators but rarely `\n\n` paragraph breaks) does not collapse into one oversized chunk per document
- Generates unique `chunkKey` values for idempotent seeding
- Supports metadata comments: `<!-- metadata: category=X, keywords=a,b,c -->`

**Semantic chunker (`semantic-chunker.ts`)** — opt-in upgrade for prose without strong structural cues (raw transcripts, PDF prose without headers):

- Embeds each sentence, measures cosine distance between adjacent sentences in the original order, and declares a chunk boundary where the distance is in the top quartile
- Cost: N embedding calls per document (a few hundred for a typical PDF). Pennies with `text-embedding-3-small`, free with local Ollama or Voyage free-tier
- Failure-safe: the caller is expected to fall back to the structural splitter if semantic chunking throws, returns empty, or the text is too short to analyse — semantic chunking is a quality upgrade, never a hard dependency

**CSV chunker (`chunker.ts#chunkCsvDocument`)** — row-atomic, one chunk per data row, batched in groups of 10 above 5,000 rows so embedding cost stays bounded.

## Search API

```typescript
import { searchKnowledge, getPatternDetail } from '@/lib/orchestration/knowledge/search';

// Semantic search
const results = await searchKnowledge(
  'chain of thought reasoning',
  { chunkType: 'pattern_overview', categories: ['ai-patterns'] },
  10, // topK (default)
  0.8 // similarityThreshold (default)
);

// Single pattern lookup
const pattern = await getPatternDetail(3);

// List all categories and keywords
const tags = await listMetaTags();
```

## Visualisation

The admin Knowledge → **Visualize** tab renders the corpus three ways:

- **Structure view** — hierarchical KB → document → chunk graph (when total chunks < 500). Powered by `GET /api/v1/admin/orchestration/knowledge/graph?view=structure[&scope=system|app]`.
- **Embedded view** — same graph rendered with embedding-derived edge weights. `view=embedded`.
- **Projection view** — UMAP / 2-D scatter of chunk embeddings via `EmbeddingProjectionView`, useful for spotting clusters and outliers in the corpus.

Use the Visualize tab as a sanity check after large ingests — clusters that should be coherent will read as one tight blob; misplaced documents stand out as orphans. Useful for catching mis-categorised uploads before they pollute retrieval.

## Seeding (dev/test data)

```
POST /api/v1/admin/orchestration/knowledge/seed
```

Idempotent — seeds from `prisma/seeds/data/chunks/chunks.json`. For programmatic use:

```typescript
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';
await seedChunks('prisma/seeds/data/chunks/chunks.json');
```

## Testing

Write tests under `tests/unit/lib/orchestration/knowledge/`. Follow existing patterns in that directory.

### What to test

1. **Chunking** — verify `chunkMarkdownDocument()` splits at section boundaries and preserves metadata
2. **Search** — verify `searchKnowledge()` returns results filtered by category and chunk type
3. **Document lifecycle** — verify status transitions: pending → processing → ready (and failed paths)
4. **URL fetch** — verify SSRF protection rejects private IPs and internal URLs

### Test template

```typescript
import { describe, it, expect } from 'vitest';
import { chunkMarkdownDocument } from '@/lib/orchestration/knowledge/chunker';

describe('Document Chunking', () => {
  it('preserves section boundaries', () => {
    const content = '# Section 1\nContent 1\n# Section 2\nContent 2';
    const chunks = chunkMarkdownDocument(content, 'test.md');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts metadata comments', () => {
    const content = '<!-- metadata: category=faq, keywords=billing,refund -->\n# FAQ\nContent';
    const chunks = chunkMarkdownDocument(content, 'faq.md');
    expect(chunks[0].metadata?.category).toBe('faq');
  });
});
```

### Running tests

```bash
npm run test -- tests/unit/lib/orchestration/knowledge/
```

## Verification Checklist

- [ ] Embedding provider created and API key configured
- [ ] Documents uploaded with appropriate categories
- [ ] Embeddings generated (`POST /knowledge/embed`)
- [ ] Embedding status shows all chunks embedded
- [ ] Agent `knowledgeCategories` set correctly
- [ ] `search_knowledge_base` capability bound to agent
- [ ] Test search returns relevant results
- [ ] PDF documents went through preview → confirm flow
- [ ] Tests written and passing under `tests/unit/lib/orchestration/knowledge/`
- [ ] `npm run validate` passes (type-check + lint + format)
- [ ] Run `/pre-pr` before merging the feature branch
