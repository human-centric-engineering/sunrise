# Evaluation pages

Admin list/create/run flows for `AiEvaluationSession`. Landed in Phase 7 Session 7.1.

**Pages**

| Route                                   | File                                                | Role                                   |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `/admin/orchestration/evaluations`      | `app/admin/orchestration/evaluations/page.tsx`      | List table with filters                |
| `/admin/orchestration/evaluations/new`  | `app/admin/orchestration/evaluations/new/page.tsx`  | Create form, prefetches agents         |
| `/admin/orchestration/evaluations/[id]` | `app/admin/orchestration/evaluations/[id]/page.tsx` | Runner/viewer, `notFound()` on missing |

All three are async server components using `serverFetch()` + `parseApiResponse()`. Fetch failures fall back to empty state or `notFound()`.

## List page

**Table:** `components/admin/orchestration/evaluations-table.tsx` (client component).

Columns:

| Column  | Source              | Notes                                             |
| ------- | ------------------- | ------------------------------------------------- |
| Title   | `evaluation.title`  | Links to detail/runner page                       |
| Agent   | `evaluation.agent`  | Agent name or `—` if deleted                      |
| Status  | `evaluation.status` | Badge: draft / in_progress / completed / archived |
| Logs    | `_count.logs`       | Right-aligned count                               |
| Created | `createdAt`         | Locale date string                                |

### Filters

- **Search**: 300ms debounced, sends `q` query param (title search)
- **Agent filter**: dropdown populated from prefetched agents list
- **Status filter**: dropdown with draft / in_progress / completed / archived

### Pagination

Previous/Next buttons, server-side pagination via `page` + `limit` params.

## Create page

**Form:** `components/admin/orchestration/evaluation-form.tsx` (react-hook-form + zodResolver).

| Field       | Type     | Validation      | FieldHelp |
| ----------- | -------- | --------------- | --------- |
| Agent       | Select   | Required        | ✓         |
| Title       | Input    | Required, ≤200  | ✓         |
| Description | Textarea | Optional, ≤5000 | ✓         |

On submit: POSTs to `/evaluations`, redirects to `/evaluations/{id}` on success.

## Runner page (detail)

**Component:** `components/admin/orchestration/evaluation-runner.tsx` — the core of the evaluation experience.

### Layout

Split-panel grid (`grid-cols-1 lg:grid-cols-2`):

- **Left panel**: Inline SSE chat connected to the evaluation's agent
- **Right panel**: Per-message annotation tools

### Chat panel

Built inline (not using `ChatInterface` component) for full message-tracking control. Uses the same SSE streaming pattern via `parseSseBlock()` from `lib/api/sse-parser.ts`. Sends `contextType: 'evaluation'` and `contextId: evaluation.id`.

### Annotation panel

Each message entry is expandable with:

- **Category buttons**: Expected / Unexpected / Issue / Observation (radio-style toggle)
- **Rating slider**: 1–5 (default 3)
- **Notes textarea**: free-text

Annotations are stored in React state as `Map<number, Annotation>`.

### Annotation persistence

Annotations are persisted to the session's `metadata` field via PATCH as flat keys:

```
ann_count: 3
ann_0_idx: 0, ann_0_cat: "expected", ann_0_rat: 4, ann_0_notes: "Good response"
ann_1_idx: 2, ann_1_cat: "issue", ann_1_rat: 2, ann_1_notes: "Hallucinated"
```

The `metadataSchema` only allows `Record<string, string|number|boolean|null>` with max 100 keys, supporting ~20 annotated messages. Auto-saves via debounced PATCH (30s).

### Status transitions

| From        | To          | Trigger                                               |
| ----------- | ----------- | ----------------------------------------------------- |
| draft       | in_progress | Auto-PATCH on runner mount (useEffect with ref guard) |
| in_progress | completed   | User clicks "Complete Evaluation" → POST /complete    |
| any         | archived    | Manual PATCH via API                                  |

### Completion flow

1. Final PATCH to save annotations to metadata
2. POST to `/evaluations/{id}/complete` (triggers AI analysis)
3. Loading state during analysis
4. On success: transitions to completed view showing summary + improvement suggestions

### Completed view

Read-only view showing:

- Evaluation metadata (title, description, agent, dates)
- AI-generated summary (prose block)
- Improvement suggestions (bulleted list)
- Token usage and cost info

### Deleted agent handling

If the evaluation's agent has been deleted, the runner shows an error state explaining the agent is unavailable. The evaluation cannot be run but can still be viewed if already completed.

## Endpoint helpers

`lib/api/endpoints.ts` provides:

| Helper                   | Route                                     |
| ------------------------ | ----------------------------------------- |
| `EVALUATIONS`            | `/api/v1/admin/orchestration/evaluations` |
| `evaluationById(id)`     | `.../evaluations/${id}`                   |
| `evaluationComplete(id)` | `.../evaluations/${id}/complete`          |
| `evaluationLogs(id)`     | `.../evaluations/${id}/logs`              |

## Related documentation

- [Admin API — Evaluations section](./../orchestration/admin-api.md) — HTTP contract
- [Chat interface](./../admin/orchestration-chat-interface.md) — Reusable chat component (not used directly here but same SSE contract)
- [SSE bridge](./../api/sse.md) — `sseResponse` helper, framing contract
