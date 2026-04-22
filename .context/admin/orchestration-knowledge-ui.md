# Knowledge Base Management

Admin page for managing knowledge base documents, seeding patterns, and testing search. Lives at `/admin/orchestration/knowledge`.

## Page

| Path                             | Component                                    | Type   |
| -------------------------------- | -------------------------------------------- | ------ |
| `/admin/orchestration/knowledge` | `app/admin/orchestration/knowledge/page.tsx` | Server |

The server page fetches documents from `GET /api/v1/admin/orchestration/knowledge/documents` and passes them to `<KnowledgeView>`.

## Components

| Component             | Type   | File                                                                 | Purpose                                               |
| --------------------- | ------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `KnowledgeView`       | Client | `components/admin/orchestration/knowledge/knowledge-view.tsx`        | Tabbed layout (Manage / Explore / Visualize / Errors) |
| `ManageTab`           | Client | `components/admin/orchestration/knowledge/manage-tab.tsx`            | Document table, seed/rechunk/delete, meta-tag panel   |
| `DocumentUploadZone`  | Client | `components/admin/orchestration/knowledge/document-upload-zone.tsx`  | Staged file upload with category input                |
| `PdfPreviewModal`     | Client | `components/admin/orchestration/knowledge/pdf-preview-modal.tsx`     | Review/correct PDF extraction before chunking         |
| `DocumentChunksModal` | Client | `components/admin/orchestration/knowledge/document-chunks-modal.tsx` | View all chunks for a document                        |
| `ExploreTab`          | Client | `components/admin/orchestration/knowledge/explore-tab.tsx`           | Vector search testing interface                       |
| `VisualizeTab`        | Client | `components/admin/orchestration/knowledge/visualize-tab.tsx`         | Interactive knowledge graph                           |
| `ErrorsTab`           | Client | `components/admin/orchestration/knowledge/errors-tab.tsx`            | Failed document recovery                              |

## Features

### Document list

Table with columns: name (clickable → chunks viewer), category badge, status badge, chunk count, created date, actions. Documents with a category show a secondary badge; documents without show "—". Status badge colors:

| Status           | Badge variant | Label        |
| ---------------- | ------------- | ------------ |
| `pending`        | outline       | Pending      |
| `pending_review` | secondary     | Needs Review |
| `processing`     | secondary     | Processing   |
| `ready`          | default       | Ready        |
| `failed`         | destructive   | Failed       |

### Document actions

| Action  | Condition                      | Endpoint                                           |
| ------- | ------------------------------ | -------------------------------------------------- |
| Rechunk | Non-seeded, not pending_review | `POST /documents/:id/rechunk`                      |
| Review  | `pending_review` status        | Opens chunks viewer                                |
| Delete  | Non-seeded                     | `DELETE /documents/:id` (with inline confirm)      |
| View    | Click document name            | Opens chunks modal via `GET /documents/:id/chunks` |

Delete uses an inline "Delete? Yes / No" confirmation pattern rather than a separate modal.

### Document content viewer

A modal (`DocumentChunksModal`) that displays all chunks for a document. Triggered by clicking a document name in the table. Shows:

- Sequential chunk list with index numbers
- Chunk type and category badges
- Estimated token count per chunk
- Content in a scrollable monospace pre block
- Keywords as small outline badges

Fetches from `GET /api/v1/admin/orchestration/knowledge/documents/:id/chunks`.

### Seed & Embed (two-step flow)

The "Built-in: Agentic Design Patterns" section provides a clear two-step flow:

1. **Load Agentic Design Patterns** — Inserts pre-chunked content (no API key needed). Idempotent.
2. **Generate Embeddings** — Sends chunks to embedding provider for vectorization. Disabled until patterns are loaded AND a provider is configured.

Shows embedding progress (X/Y embedded) and "Last seeded" timestamp.

### File upload (staged flow)

Two-step upload: drop/select a file → the file is staged (not uploaded yet) → optionally assign a category → click Upload.

1. **Drag-and-drop zone** with file input fallback. Client-side validation: max 50 MB, `.md` / `.markdown` / `.txt` / `.epub` / `.docx` / `.pdf`
2. **Staged preview** shows file name, size, and a category text input with autocomplete (populated from `GET /knowledge/meta-tags`)
3. **Upload button** posts multipart `FormData` (with `file` and optional `category` fields) to `POST /knowledge/documents`
4. **Clear button** (×) unstages the file without uploading

**PDF flow:** When a PDF is uploaded, the API returns a preview response. The upload zone calls `onPdfPreview` which opens the `PdfPreviewModal` for review.

The `<FieldHelp>` popover covers: chunking/embedding pipeline, category usage, in-document metadata comment format, supported formats with per-format notes, content quality tips, and large document guidance.

### PDF preview modal

Opened automatically after a PDF upload. Displays:

- Document metadata (title, author, section count)
- Extraction warnings (amber callout box)
- Editable textarea with extracted text (for correcting OCR errors)
- Optional category input
- Confirm & Chunk button → calls `POST /documents/:id/confirm`
- Discard button → calls `DELETE /documents/:id`

### Meta-tags panel

Displayed below the upload zone when any categories or keywords exist in either scope. Fetched from `GET /knowledge/meta-tags` on mount. The response is grouped by scope (`app` vs `system`), rendered as two collapsible sections:

- **App knowledge** (expanded by default) — tags from user-uploaded documents. These are the tags admins manage for consistency.
- **System knowledge** (collapsed by default) — tags from the built-in Agentic Design Patterns. Read-only reference.

Each section shows:

- **Categories** — secondary badges with tooltip showing chunk/document counts
- **Keywords** — outline badges, first 30 visible. A "Show all N keywords" / "Show less" toggle reveals the rest.

### Explore tab

Debounced search input (400ms, min 3 chars). Results show similarity scores with color coding (green ≥80%, amber ≥60%, red <60%), chunk type badges, content preview, and a detail modal with full metadata.

### Visualize tab

Interactive ECharts force-directed graph. Two view modes (Structure / Embedded), stats cards, node filtering, fullscreen toggle.

### Errors tab

Lists documents with `status: 'failed'`. Each shows error message in monospace. Actions: Retry (resets to pending), Delete (with confirmation modal).

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface pages
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/document-ingestion.md`](../orchestration/document-ingestion.md) — Multi-format parser pipeline
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
