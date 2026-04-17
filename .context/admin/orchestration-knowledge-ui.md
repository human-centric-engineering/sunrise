# Knowledge Base Management

Admin page for managing knowledge base documents, seeding patterns, and testing search. Lives at `/admin/orchestration/knowledge`.

## Page

| Path                             | Component                                    | Type   |
| -------------------------------- | -------------------------------------------- | ------ |
| `/admin/orchestration/knowledge` | `app/admin/orchestration/knowledge/page.tsx` | Server |

The server page fetches documents from `GET /api/v1/admin/orchestration/knowledge/documents` and passes them to `<KnowledgeView>`.

## Components

| Component            | Type   | File                                                                | Purpose                                      |
| -------------------- | ------ | ------------------------------------------------------------------- | -------------------------------------------- |
| `KnowledgeView`      | Client | `components/admin/orchestration/knowledge/knowledge-view.tsx`       | Tabbed layout (Manage / Search / Graph)      |
| `ManageTab`          | Client | `components/admin/orchestration/knowledge/manage-tab.tsx`           | Document table, seed/rechunk, meta-tag panel |
| `DocumentUploadZone` | Client | `components/admin/orchestration/knowledge/document-upload-zone.tsx` | Staged file upload with category input       |
| `SearchTest`         | Client | `components/admin/orchestration/knowledge/search-test.tsx`          | Search query testing interface               |

## Features

### Document list

Table with columns: name, category badge, status badge, chunk count, created date, actions. Documents with a category show a secondary badge; documents without show "—". Status badge colors:

| Status       | Badge variant |
| ------------ | ------------- |
| `pending`    | outline       |
| `processing` | secondary     |
| `ready`      | default       |
| `failed`     | destructive   |

### Seed button

Calls `POST /api/v1/admin/orchestration/knowledge/seed` to load built-in agentic design patterns. Idempotent — safe to click multiple times.

### Rechunk

Per-document action. Calls `POST /api/v1/admin/orchestration/knowledge/documents/:id/rechunk`. Use after improving chunking logic.

### File upload (staged flow)

Two-step upload: drop/select a file → the file is staged (not uploaded yet) → optionally assign a category → click Upload.

1. **Drag-and-drop zone** with file input fallback. Client-side validation: max 10 MB, `.md` / `.markdown` / `.txt` only
2. **Staged preview** shows file name, size, and a category text input with autocomplete (populated from `GET /knowledge/meta-tags`)
3. **Upload button** posts multipart `FormData` (with `file` and optional `category` fields) to `POST /knowledge/documents`
4. **Clear button** (×) unstages the file without uploading

The `<FieldHelp>` popover covers: chunking/embedding pipeline, category usage, in-document metadata comment format (`<!-- metadata: category=X, keywords="a,b" -->`), supported tags, free-form tagging trade-offs, content quality tips, large document guidance, and supported file formats.

### Meta-tags panel

Displayed below the upload zone when any categories or keywords exist in either scope. Fetched from `GET /knowledge/meta-tags` on mount. The response is grouped by scope (`app` vs `system`), rendered as two collapsible sections:

- **App knowledge** (expanded by default) — tags from user-uploaded documents. These are the tags admins manage for consistency.
- **System knowledge** (collapsed by default) — tags from the built-in Agentic Design Patterns. Read-only reference.

Each section shows:

- **Categories** — secondary badges with tooltip showing chunk/document counts
- **Keywords** — outline badges, first 30 visible. A "Show all N keywords" / "Show less" toggle reveals the rest.

The panel-level **FieldHelp** (with `max-h-80 overflow-y-auto` to prevent viewport overflow) explains scope separation, consistency implications (case-sensitivity, agent scoping), and free-form tagging trade-offs.

### Search test

Text input + submit. Posts to `POST /api/v1/admin/orchestration/knowledge/search`. Displays results with similarity scores and chunk type badges.

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface pages
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
