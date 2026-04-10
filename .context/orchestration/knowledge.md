# Agent Orchestration — Knowledge Base

Document ingestion, chunking, embeddings, and vector search for the agent knowledge base. Implemented in `lib/orchestration/knowledge/` — platform-agnostic (no `next/*` imports).

**HTTP surface:** see [`admin-api.md`](./admin-api.md) — the "Knowledge Base" section covers the six admin routes (`/search`, `/patterns/:number`, `/documents`, `/documents/:id`, `/documents/:id/rechunk`, `/seed`).

## Module Layout

| File                  | Exports                               | Purpose                                                 |
| --------------------- | ------------------------------------- | ------------------------------------------------------- |
| `document-manager.ts` | `documentManager` (singleton)         | Upload, delete, rechunk, list documents                 |
| `search.ts`           | `searchKnowledge`, `getPatternDetail` | Vector + keyword search; single-pattern lookup          |
| `seeder.ts`           | `seedFromChunksJson`                  | Idempotent seeder for the "Agentic Design Patterns" doc |
| `chunker.ts`          | internal                              | Markdown → chunks with type classification              |
| `embedder.ts`         | internal                              | Generates embeddings for chunks                         |

## Quick Start

```typescript
import { documentManager } from '@/lib/orchestration/knowledge/document-manager';
import { searchKnowledge, getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { seedFromChunksJson } from '@/lib/orchestration/knowledge/seeder';

// Upload (admin flow — content is a string, not a file handle)
const doc = await documentManager.uploadDocument(markdownContent, 'react-patterns.md', userId);

// Vector search
const results = await searchKnowledge(
  'chain of thought reasoning',
  { chunkType: 'pattern_overview' },
  10
);

// Single pattern lookup
const pattern = await getPatternDetail(3);

// Seed (idempotent — see below)
await seedFromChunksJson('lib/orchestration/seed/chunks.json');
```

## Document Lifecycle

`AiKnowledgeDocument.status` moves through four states:

```
pending → processing → ready
                    ↘ failed
```

| Status       | Meaning                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `pending`    | Row created, chunking not yet started. Rare — most uploads transition out of this state synchronously. |
| `processing` | Chunker is running. `rechunk` is blocked in this state (409 `ConflictError` from the admin route).     |
| `ready`      | All chunks and embeddings are persisted. Searchable.                                                   |
| `failed`     | Chunking or embedding threw. The document row stays in place for inspection / retry via rechunk.       |

## Upload

`documentManager.uploadDocument(content: string, fileName: string, userId: string)` parses the markdown, generates chunks, embeds them, and writes the `AiKnowledgeDocument` + `AiKnowledgeChunk` rows in one go.

The admin upload route (`POST /knowledge/documents`) is the caller for human-initiated uploads:

- **Multipart only** (`multipart/form-data`), `file` field
- **10 MB max** (`MAX_UPLOAD_BYTES = 10 * 1024 * 1024` in the route)
- **Extension whitelist**: `.md`, `.markdown`, `.txt` — text only this session. PDF / HTML are future work (they need `pdf-parse` / `sanitize-html` plus new chunker branches)
- MIME type is advisory — the extension is the source of truth
- Returns the created document at 201 with the standard response envelope

Knowledge documents are **not per-user scoped**. `uploadedBy` is stored for audit, but GET / DELETE / rechunk work on any document regardless of which admin created it.

## Search

`searchKnowledge(query, filters?, limit?, threshold?)` runs a hybrid cosine-similarity + keyword-boost search via pgvector. Filters support `documentId` and `chunkType` (see `knowledgeSearchSchema` in `lib/validations/orchestration.ts` for the full enum).

Results are ranked chunks with their parent document metadata — the admin search route (`POST /knowledge/search`) surfaces this directly. POST (not GET) because the filter payload can contain arbitrary text and we don't want query bodies in URL logs.

`getPatternDetail(patternNumber)` is a specialized lookup that returns all chunks tagged with a given pattern number in source order — used by the admin `GET /knowledge/patterns/:number` route and by the `buildContext` path in the streaming chat handler. Returns 404 (via `NotFoundError` in the route) when no chunks exist.

## Rechunking

`documentManager.rechunkDocument(id)` deletes the current chunks, re-runs the chunker + embedder, and writes fresh rows. Use it after:

- Improving `chunker.ts` (e.g. better markdown heading detection, new chunk type classification)
- Fixing a chunk classification bug for a specific document
- Changing the embedding model (future — currently fixed)

The admin route guards against double-rechunk: if the document is currently `status === 'processing'` it returns 409 `ConflictError` rather than racing.

## Seeder

`seedFromChunksJson(chunksJsonPath)` loads a pre-built chunks file and upserts a single canonical document — the "Agentic Design Patterns" reference that the built-in `get_pattern_detail` and `search_knowledge_base` capabilities rely on.

**The seeder is idempotent.** Safe to call on every deploy: if the "Agentic Design Patterns" document already exists, the seeder is a no-op. Don't wrap calls in existence checks — that's the seeder's job.

Seed file lives at `lib/orchestration/seed/chunks.json`. The admin route (`POST /knowledge/seed`) resolves this via `path.join(process.cwd(), 'lib/orchestration/seed/chunks.json')` and returns `{ seeded: true }` when the call completes.

## Anti-Patterns

**Don't** bypass `documentManager` for uploads — it owns the chunk/embedding write ordering. Direct `prisma.aiKnowledgeDocument.create` skips the chunker entirely and leaves an unsearchable document.

**Don't** add a "knowledge scope" check to the admin routes. Knowledge is a global asset by design — adding per-user scoping would fork the admin and runtime capability code paths.

**Don't** add PDF or HTML parsing to `chunker.ts` without adding the extension to the admin route whitelist in the same change. The whitelist is the source of truth; adding parsers without updating it leaves dormant code.

**Don't** rely on `file.type` (the MIME header) for security — browsers frequently omit it for `.md` files. The `.md` / `.markdown` / `.txt` extension check is the load-bearing validation.

**Don't** import from `next/*` inside `lib/orchestration/knowledge/` — keep it platform-agnostic. HTTP wrapping lives in `app/api/v1/admin/orchestration/knowledge/*`.

## Related Documentation

- [Admin API — Knowledge Base](./admin-api.md) — HTTP surface for all six routes
- [Capabilities](./capabilities.md) — `search_knowledge_base` and `get_pattern_detail` built-in tools that consume this layer
- [Streaming Chat](./chat.md) — `buildContext` uses `getPatternDetail` for locked-context injection
- `prisma/schema.prisma` — `AiKnowledgeDocument`, `AiKnowledgeChunk` models
- `lib/validations/orchestration.ts` — `knowledgeSearchSchema`, `listDocumentsQuerySchema`, `getPatternParamSchema`
