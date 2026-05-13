# Knowledge Base Management

Admin page for managing knowledge base documents, seeding patterns, and testing search. Lives at `/admin/orchestration/knowledge`.

## Page

| Path                             | Component                                    | Type   |
| -------------------------------- | -------------------------------------------- | ------ |
| `/admin/orchestration/knowledge` | `app/admin/orchestration/knowledge/page.tsx` | Server |

The server page fetches documents from `GET /api/v1/admin/orchestration/knowledge/documents` and passes them to `<KnowledgeView>`.

## Components

| Component                 | Type   | File                                                                     | Purpose                                                                           |
| ------------------------- | ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `KnowledgeView`           | Client | `components/admin/orchestration/knowledge/knowledge-view.tsx`            | Tabbed layout (Manage / Explore / Visualize / Errors)                             |
| `ManageTab`               | Client | `components/admin/orchestration/knowledge/manage-tab.tsx`                | Document table, seed / rechunk / enrich-keywords / delete, Indexed keywords panel |
| `DocumentUploadZone`      | Client | `components/admin/orchestration/knowledge/document-upload-zone.tsx`      | Staged file upload with title + tags (inline-create)                              |
| `PdfPreviewModal`         | Client | `components/admin/orchestration/knowledge/pdf-preview-modal.tsx`         | Review/correct PDF extraction before chunking                                     |
| `DocumentChunksModal`     | Client | `components/admin/orchestration/knowledge/document-chunks-modal.tsx`     | View all chunks for a document                                                    |
| `ExploreTab`              | Client | `components/admin/orchestration/knowledge/explore-tab.tsx`               | Vector search testing interface                                                   |
| `VisualizeTab`            | Client | `components/admin/orchestration/knowledge/visualize-tab.tsx`             | Interactive knowledge graph (Structure / Embedded views) + view-toggle host       |
| `EmbeddingProjectionView` | Client | `components/admin/orchestration/knowledge/embedding-projection-view.tsx` | 2D scatter of UMAP-projected chunk embeddings (the "Embedding space" view)        |
| `ErrorsTab`               | Client | `components/admin/orchestration/knowledge/errors-tab.tsx`                | Failed document recovery                                                          |
| `CompareProvidersModal`   | Client | `components/admin/orchestration/knowledge/compare-providers-modal.tsx`   | Embedding model comparison table with guide                                       |
| `EmbeddingStatusBanner`   | Client | `components/admin/orchestration/knowledge/embedding-status-banner.tsx`   | Warning banner when embeddings are incomplete                                     |

## Features

### Document list

Table with columns: name (clickable → chunks viewer), tag count chip (clickable → tags modal), status badge, chunk count, **coverage**, created date, actions. The tag chip shows `N tag(s)` when any are applied and a `+ Add` affordance when none are; both open the document's tags modal. The Coverage column shows the post-chunking text-capture percentage from `document.metadata.coverage.coveragePct`. Green (≥ 95%) indicates all parsed text was captured; amber indicates content was likely dropped. Older documents without a coverage metric show `—`; rechunking computes it. Status badge colors:

| Status           | Badge variant | Label        |
| ---------------- | ------------- | ------------ |
| `pending`        | outline       | Pending      |
| `pending_review` | secondary     | Needs Review |
| `processing`     | secondary     | Processing   |
| `ready`          | default       | Ready        |
| `failed`         | destructive   | Failed       |

### Document actions

| Action          | Condition                      | Endpoint                                                                                   |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Rechunk         | Non-seeded, not pending_review | `POST /documents/:id/rechunk`                                                              |
| Enrich keywords | Non-seeded, not pending_review | `POST /documents/:id/enrich-keywords` (LLM-summarises each chunk into 3–8 keyword phrases) |
| Review          | `pending_review` status        | Opens chunks viewer                                                                        |
| Delete          | Non-seeded                     | `DELETE /documents/:id` (with inline confirm)                                              |
| View            | Click document name            | Opens chunks modal via `GET /documents/:id/chunks`                                         |
| Edit tags       | Click tag count chip           | Opens tags modal — picks from existing tags                                                |

Delete uses an inline "Delete? Yes / No" confirmation pattern rather than a separate modal.

### Document content viewer

A modal (`DocumentChunksModal`) that displays all chunks for a document. Triggered by clicking a document name in the table. Shows:

- Sequential chunk list with index numbers
- Chunk type and category badges
- Estimated token count per chunk
- Content in a scrollable monospace pre block
- Keywords as small outline badges
- Green/amber coverage banner: `X% of source text captured (chunkChars of parsedChars chars)` with a FieldHelp explaining the metric
- Ingestion warnings list (parser warnings + low-coverage notice)

Fetches from `GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks`.

### Seed & Embed (two-step flow)

The "Built-in: Agentic Design Patterns" section provides a clear two-step flow:

1. **Load Agentic Design Patterns** — Inserts pre-chunked content (no API key needed). Idempotent.
2. **Generate Embeddings** — Sends chunks to embedding provider for vectorization. Disabled until patterns are loaded AND a provider is configured.

Shows embedding progress (X/Y embedded) and "Last seeded" timestamp.

The panel renders near the top of the page while setup is in progress. Once both steps are complete (`allEmbedded = true`), it auto-collapses and moves to the **bottom** of the page so it doesn't dominate the operator's view. The user can expand/collapse manually at any time via the header button; the preference persists in `localStorage` under `orchestration.knowledge.builtin-patterns-panel`.

### File upload (staged flow)

Staged upload: drop/select one or more files → files are staged (not uploaded yet) → optionally edit the title and apply tags → click Upload. Maximum 10 files per batch.

1. **Drag-and-drop zone** with file input fallback (supports `multiple`). Client-side validation: max 50 MB per file, `.md` / `.markdown` / `.txt` / `.epub` / `.docx` / `.pdf`
2. **Staged preview** shows file names with sizes. For single-file uploads, a **Title** input appears (seeded from the filename stem; sent as `name` only when edited).
3. **Tags picker** — a `MultiSelect` bound to `KnowledgeTag` rows fetched from `GET /knowledge/tags`. Operators can pick from existing tags or type a name that doesn't match anything to create a new tag inline (the picker fires `POST /knowledge/tags` and auto-selects the result). Submitted as repeated `tagIds` form fields.
4. **Upload button** — single file posts multipart `FormData` to `POST /knowledge/documents`; multiple files use `POST /knowledge/documents/bulk`
5. **Clear button** (×) unstages all files without uploading

**PDF flow:** When a PDF is uploaded, the API returns a preview response. The upload zone calls `onPdfPreview` which opens the `PdfPreviewModal` for review. The preview modal does **not** offer a tags input — apply tags at upload time on the upload zone (the doc row's tags modal also works post-confirm).

### Chunking settings

A read-only informational ⓘ button sits underneath the upload zone and opens a
`<FieldHelp>` popover showing the live chunker constants:

| Setting        | Value          | Meaning                                           |
| -------------- | -------------- | ------------------------------------------------- |
| Min chunk size | 50 tokens      | Below this, neighbouring sections merge           |
| Max chunk size | 800 tokens     | Above this, sections split                        |
| Token estimate | ~4 chars/token | Heuristic used by the chunker (English text)      |
| CSV row cap    | 32,000 chars   | Rows above this are dropped and named in warnings |

Plus the split hierarchy: paragraph → line → sentence → fixed-width window.

Values are sourced from `lib/orchestration/knowledge/chunker-config.ts` (a
server-free constants file) so the UI can never drift from the runtime.

**Inline upload explainer.** Above the drop zone an `<aside>` card carries a one-paragraph summary of how upload works (parse → chunk into ~50–800-token pieces → embed into 1,536-dim vectors → graph nodes) with a **Read full guide** popover that opens the complete guide body. The same guide body is also wired to the (ⓘ) `<FieldHelp>` next to the "Upload Document" heading — hoisted into a shared `<UploadGuideBody />` component so a future edit lands in one place. The guide covers: the parse → chunk → embed pipeline; what you'll see in the graph (nodes/edges, per-document-size chunk-count examples, the 500-chunk graph-collapse threshold); Tags vs Indexed Keywords (access vs ranking); the `<!-- metadata: keywords="…" -->` format for markdown uploads; content quality tips; large-document guidance; supported formats.

### PDF preview modal

Opened automatically after a PDF upload. Displays:

- Document metadata (title, author, section count)
- Extraction warnings (amber callout box)
- Editable textarea with extracted text (for correcting OCR errors)
- Confirm & Chunk button → calls `POST /documents/:id/confirm`
- Discard button → calls `DELETE /documents/:id`
- Page-coverage banner: `X% of pages produced text (N of M pages, K chars total)` green/amber — pre-chunking signal. Below 95% indicates scanned pages.
- Per-page extraction bar strip: one bar per page, height proportional to char count, amber for scanned-suspect pages

### Indexed keywords panel

Read-only diagnostic. Displayed below the upload zone when any indexed keywords exist in either scope. Fetched from `GET /knowledge/meta-tags` on mount; only the `keywords` half of the response is rendered (the `categories` half is legacy data that will go away in Phase 6). Grouped by scope into two collapsible sections:

- **App knowledge** (expanded by default) — keywords from user-uploaded documents.
- **System knowledge** (collapsed by default) — keywords from the built-in Agentic Design Patterns reference. Read-only.

Each section shows keywords as outline badges, first 30 visible. A "Show all N keywords" / "Show less" toggle reveals the rest. Tooltips show chunk/document counts per keyword.

The panel's purpose is **diagnostic only** — to spot duplicates / typos that hurt BM25 ranking. To actually set keywords on a document, see the **Enrich keywords** per-row action on the document table, or use `<!-- metadata: keywords="…" -->` HTML comments in markdown source.

Tags (the access-control concept) have their own dedicated tab — Knowledge → Tags — not surfaced here.

### Explore tab

Debounced search input (400ms, min 3 chars). Results show similarity scores with color coding (green ≥80%, amber ≥60%, red <60%), chunk type badges, content preview, and a detail modal with full metadata.

When hybrid search is enabled (Settings → Knowledge search → Enable hybrid search), each result instead shows a three-segment score: a final-score badge plus a `v <vector_score> • k <keyword_score>` sub-line. The detail modal surfaces all three components individually (Vector / Keyword (BM25) / Final). When hybrid is off, the legacy single-percentage badge is rendered. The fall-back is purely additive — the API includes the hybrid fields only when the search engine produced them, so the tab needs no toggle of its own.

### Visualize tab

Interactive ECharts visualisation of the knowledge base with **three view modes** the operator toggles between:

| View                | What it shows                                                                                                                                                                                                                                            | Data source                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Structure**       | Force-directed graph: every Knowledge Base → Document → Chunk relationship. Chunk nodes drawn when total chunks ≤ 500; above that the graph collapses to KB + documents for performance and an aggregation note appears.                                 | `GET /knowledge/graph?view=structure` |
| **Embedded**        | Same graph topology, filtered to chunks that have a stored embedding vector. Documents with zero embedded chunks are hidden entirely. Useful for auditing "what is actually searchable by my agents".                                                    | `GET /knowledge/graph?view=embedded`  |
| **Embedding space** | 2D scatter plot — each chunk is one point. Position derived from the chunk's 1,536-dim embedding via UMAP run server-side. Neighbouring points = semantically similar text; visible clusters = topics the KB covers. Points coloured by source document. | `GET /knowledge/embeddings`           |

**Per-view explainer affordance.** The toggle row carries a one-line caption next to each view that explains what it shows; a `<FieldHelp>` (ⓘ) on each gives full depth — Structure / Embedded explain the 500-chunk threshold, Embedding space explains UMAP, the 75th-percentile breakpoint heuristic, the 2,000-point sample cap, and the 10-chunk minimum below which the layout is degenerate. The shared "Knowledge Graph" FieldHelp above the toggle covers cross-view context (what nodes/edges are, interaction model: hover / drag / scroll / click).

**Force-layout seeding.** ECharts' default force layout assigns random positive starting coordinates and the auto-fitted view box centres on that quadrant, which pushed the KB node into the top-left corner. The component now seeds the KB node at `(0, 0)` with `fixed: true` and distributes document nodes evenly on a circle of radius 100 around it (first doc at the top, -π/2). Chunk nodes aren't seeded — repulsion from their parent document pushes them outward naturally — and the KB ends up visually centred.

**Embedding-space rendering details:**

- One ECharts scatter series per source document; 12-colour palette wraps modulo for the 13th+ document. Legend is bottom-aligned and scrollable when document count exceeds the horizontal space.
- Below 10 embedded chunks the view shows an amber sub-minimum warning explaining the layout is degenerate (all points stack at the origin), but still renders the scatter so the user sees the points exist.
- Above 2,000 chunks the response is uniformly sampled (every `ceil(totalEmbedded / 2000)`-th by id); an amber truncation banner explains.
- Tooltip HTML-escapes user-influenced strings (document name, chunk content preview) so a chunk containing `<script>` can't inject DOM into the tooltip (ECharts uses `innerHTML` for `formatter` return values).
- A **Recompute** button refetches and reruns UMAP — useful after an embedding-model swap or knowledge-base mutation.

**Click→detail dialog.** Clicking any chunk node (Structure / Embedded views) or any point (Embedding space view) opens a modal showing the chunk's metadata: document name, chunk type (with snake_case rendered as spaces — `pattern_section` → `pattern section`), section title, token count, embedding provider + model, and the chunk's `contentPreview` text. The dialog is the same code path across all three views.

**Source:** `components/admin/orchestration/knowledge/visualize-tab.tsx` (the toggle, Structure / Embedded graph) and `components/admin/orchestration/knowledge/embedding-projection-view.tsx` (the scatter plot, called as a child when the user picks "Embedding space").

### Errors tab

Lists documents with `status: 'failed'`. Each shows error message in monospace. Actions: Retry (resets to pending), Delete (with confirmation modal).

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface pages
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/document-ingestion.md`](../orchestration/document-ingestion.md) — Multi-format parser pipeline
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
