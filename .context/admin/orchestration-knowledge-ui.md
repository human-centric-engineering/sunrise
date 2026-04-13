# Knowledge Base Management

Admin page for managing knowledge base documents, seeding patterns, and testing search. Lives at `/admin/orchestration/knowledge`.

## Page

| Path                             | Component                                    | Type   |
| -------------------------------- | -------------------------------------------- | ------ |
| `/admin/orchestration/knowledge` | `app/admin/orchestration/knowledge/page.tsx` | Server |

The server page fetches documents from `GET /api/v1/admin/orchestration/knowledge/documents` and passes them to `<KnowledgeView>`.

## Components

| Component            | Type   | File                                                                | Purpose                              |
| -------------------- | ------ | ------------------------------------------------------------------- | ------------------------------------ |
| `KnowledgeView`      | Client | `components/admin/orchestration/knowledge/knowledge-view.tsx`       | Document table, seed/rechunk actions |
| `DocumentUploadZone` | Client | `components/admin/orchestration/knowledge/document-upload-zone.tsx` | Drag-drop file upload                |
| `SearchTest`         | Client | `components/admin/orchestration/knowledge/search-test.tsx`          | Search query testing interface       |

## Features

### Document list

Table with columns: name, status badge, chunk count, created date, actions. Status badge colors:

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

### File upload

Drag-and-drop zone with file input fallback. Client-side validation:

- **Max size:** 10 MB
- **Allowed extensions:** `.md`, `.markdown`, `.txt`

Posts multipart `FormData` to `POST /api/v1/admin/orchestration/knowledge/documents`. Includes `<FieldHelp>` popover explaining accepted formats.

### Search test

Text input + submit. Posts to `POST /api/v1/admin/orchestration/knowledge/search`. Displays results with similarity scores and chunk type badges.

## Related

- [`orchestration-learn.md`](./orchestration-learn.md) — Learning interface pages
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
