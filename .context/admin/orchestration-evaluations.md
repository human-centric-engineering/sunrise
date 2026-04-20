# Evaluation pages

Admin list/create/run flows for `AiEvaluationSession`. Landed in Phase 7 Session 7.1, revised in 7.2.

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
| Actions | —                   | Dropdown menu (Archive). Hidden for archived rows |

### Filters

- **Search**: 300ms debounced, sends `q` query param (title search)
- **Agent filter**: dropdown populated from prefetched agents list
- **Status filter**: dropdown with draft / in_progress / completed / archived

### Pagination

Previous/Next buttons, server-side pagination via `page` + `limit` params.

### Row actions

Each non-archived row has a `...` dropdown menu with:

- **Archive** — opens a confirmation dialog, PATCHes `status: 'archived'`, removes row from list on success

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

### Action bar

Above the split panel:

- **Archive button** — opens confirmation dialog, PATCHes status to `archived`. Available for draft/in_progress evaluations.

### Layout

Split-panel grid (`grid-cols-1 lg:grid-cols-2`):

- **Left panel**: Inline SSE chat connected to the evaluation's agent
- **Right panel**: Per-message annotation tools

### Chat panel

Built inline (not using `ChatInterface` component) for full message-tracking control. Uses the same SSE streaming pattern via `parseSseBlock()` from `lib/api/sse-parser.ts`. Sends `contextType: 'evaluation'` and `contextId: evaluation.id`.

**Log restoration on mount:** When returning to an in-progress evaluation, the runner fetches existing logs via `GET /evaluations/{id}/logs?limit=500` and reconstructs the message history. Only `user_input` and `ai_response` event types are rendered as chat messages.

### Annotation panel

Header includes a manual **Save button** (floppy disk icon) for immediate annotation persistence.

Each message entry is expandable with:

- **Category buttons**: Expected / Unexpected / Issue / Observation (radio-style toggle)
- **Rating slider**: 1–5 (default 3)
- **Notes textarea**: free-text

Annotations are stored in React state as `Map<number, Annotation>`.

### Annotation limit

The metadata format supports a maximum of **24 non-default annotations** (4 keys each + `ann_count` = 97 keys max, within the 100-key metadata limit).

- **Warning banner**: shown when 4 or fewer slots remain
- **Limit reached banner**: shown at 0 remaining slots

### Annotation persistence

Annotations are persisted to the session's `metadata` field via PATCH as flat keys:

```
ann_count: 3
ann_0_idx: 0, ann_0_cat: "expected", ann_0_rat: 4, ann_0_notes: "Good response"
ann_1_idx: 2, ann_1_cat: "issue", ann_1_rat: 2, ann_1_notes: "Hallucinated"
```

The `metadataSchema` only allows `Record<string, string|number|boolean|null>` with max 100 keys.

**Save mechanisms:**

1. **Auto-save**: 30-second debounce after any annotation change (uses `annotationsRef.current` to avoid stale closures)
2. **Manual save**: Save button in annotation panel header for immediate persistence
3. **Pre-completion save**: annotations are saved before triggering AI analysis

### Status transitions

| From        | To          | Trigger                                                              |
| ----------- | ----------- | -------------------------------------------------------------------- |
| draft       | in_progress | Auto-PATCH on runner mount (useEffect with ref guard)                |
| in_progress | completed   | User clicks "Complete Evaluation" → confirms dialog → POST /complete |
| any         | archived    | Archive button (with confirmation) or manual PATCH via API           |

### Completion flow

1. User clicks "Complete Evaluation" button
2. **Confirmation dialog** appears warning the action is irreversible
3. On confirm: final PATCH to save annotations to metadata
4. POST to `/evaluations/{id}/complete` (triggers AI analysis)
5. Loading state during analysis ("Analysing…")
6. On success: transitions to completed view

### Completed view

Read-only view showing:

- Evaluation metadata (title, description, agent, dates)
- AI-generated summary (prose block)
- Improvement suggestions (bulleted list)
- Token usage and cost info
- **Conversation transcript** — loads from `/evaluations/{id}/logs` and renders as chat bubbles. Shows "No transcript available." if logs are empty or fetch fails.

### Archived view

Simple centered message: "This evaluation has been archived." No chat panel or annotations rendered.

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

## Key implementation details

### Stale closure prevention

The `updateAnnotation` callback uses `[]` deps for stable identity. The debounced auto-save reads from `annotationsRef.current` (a ref kept in sync with state) rather than relying on the closure-captured annotations value. This prevents saving stale/empty annotations.

### Log-to-message conversion

The `logsToMessages()` helper filters log entries to only `user_input` and `ai_response` event types, mapping them to `{ role, content }` chat messages. Capability calls and errors are excluded from the chat display.

### Annotation counting

`countActiveAnnotations()` counts entries with any non-default value (category set, rating != 3, or notes non-empty). This matches the serialization logic that skips fully-default entries.

## Related documentation

- [Admin API — Evaluations section](./../orchestration/admin-api.md) — HTTP contract
- [Chat interface](./../admin/orchestration-chat-interface.md) — Reusable chat component (not used directly here but same SSE contract)
- [SSE bridge](./../api/sse.md) — `sseResponse` helper, framing contract
