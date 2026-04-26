# Orchestration Experiments (A/B Testing)

The experiments system allows admins to compare multiple agent variants side-by-side. Each experiment runs against a single agent and defines 2–5 variants (different agent versions or configurations). Running an experiment transitions it from `draft` → `running` and (when stopped) to `completed`.

## Architecture

```
app/api/v1/admin/orchestration/experiments/
├── route.ts           — GET list, POST create
├── [id]/route.ts      — GET one, PATCH update, DELETE
└── [id]/run/route.ts  — POST start experiment

app/admin/orchestration/experiments/page.tsx
components/admin/orchestration/experiments/experiments-list.tsx
```

Prisma model: `AiExperiment` with `AiExperimentVariant[]`.

## Endpoints

### List experiments

```
GET /api/v1/admin/orchestration/experiments
Authorization: Admin
Query:
  page        integer (default 1)
  limit       integer (default 20)
  status      "draft" | "running" | "completed"
  agentId     string

Response 200: { success: true, data: Experiment[], meta: { page, limit, total, totalPages } }
```

### Create experiment

```
POST /api/v1/admin/orchestration/experiments
Authorization: Admin
Rate limit: adminLimiter

Body:
{
  name:        string (1–200 chars, required)
  description: string (max 2000, optional)
  agentId:     string (required)
  variants: [           // min 2, max 5
    { label: string, agentVersionId?: string },
    ...
  ]
}

Response 201: { success: true, data: Experiment }
Audit: experiment.create
```

### Get experiment

```
GET /api/v1/admin/orchestration/experiments/:id
Response 200: { success: true, data: Experiment }
```

### Update experiment

```
PATCH /api/v1/admin/orchestration/experiments/:id
Authorization: Admin
Rate limit: adminLimiter

Body: { name?, description?, status? }   — at least one field required

Status transitions are validated:
  draft    → running, completed
  running  → completed
  completed → (none — terminal state)

Invalid transitions return 400 VALIDATION_ERROR.

Response 200: { success: true, data: Experiment }
Audit: experiment.update
```

### Delete experiment

```
DELETE /api/v1/admin/orchestration/experiments/:id
Authorization: Admin
Rate limit: adminLimiter

Validation:
  - status must not be "running" → 400 "Cannot delete a running experiment"

Response 200: { success: true, data: { deleted: true } }
Audit: experiment.delete
```

### Run experiment

```
POST /api/v1/admin/orchestration/experiments/:id/run
Authorization: Admin
Rate limit: adminLimiter

Validation:
  - status must be "draft"       → 400 "Experiment is already {status}"
  - variants.length >= 2         → 400 "Experiment needs at least 2 variants to run"

Effect: sets status → "running"
Response 200: { success: true, data: Experiment }
Audit: experiment.run
```

## Status lifecycle

```
draft → running → completed
  │        ↑          (terminal)
  │   POST /run
  └──────────────► completed   (skip running via PATCH)
```

- Only `draft` experiments can be run via `POST /run`.
- `running → completed` via PATCH or the UI "Complete" button.
- `draft → completed` via PATCH (cancel without running).
- `completed` is terminal — no transitions out.

## Variant shape

```typescript
interface ExperimentVariant {
  id: string;
  experimentId: string;
  label: string; // e.g. "Control", "Treatment A"
  agentVersionId?: string | null; // pin to a snapshot; null = current live config
  evaluationSessionId?: string | null; // filled when experiment runs
  score?: number | null; // filled in after evaluation
}
```

## Admin UI

### Where it lives

Experiments do **not** have a standalone page. `/admin/orchestration/experiments` is a server-side redirect to `/admin/orchestration/evaluations?tab=experiments`. The actual surface is the **Experiments tab** on the unified Testing page (`app/admin/orchestration/evaluations/page.tsx`), which sits alongside an Evaluations tab.

```
/admin/orchestration/experiments  ──307──►  /admin/orchestration/evaluations?tab=experiments
```

The `defaultTab` is read from the `tab` query param — `experiments` opens the experiments tab, anything else (or absent) opens evaluations. This keeps the two workflows — evaluate a single agent vs A/B-compare variants — in one navigable surface.

### `ExperimentsList` (`components/admin/orchestration/experiments/experiments-list.tsx`)

Client-only island. Mounts with a `GET /experiments` fetch, stores the rows in local state, and mutates via `apiClient.post`/`delete` then re-fetches.

**List row:** name + optional description, agent name, status badge (`draft` / `running` / `completed`), variant count, created date, actions.

Completed experiments inline each variant's score under the name cell (`Variant A: 0.82  Variant B: 0.67`). Scores are read from `variant.score` — `N/A` when null.

**Per-row actions:**

| Action   | Visibility                   | Call                                                                      |
| -------- | ---------------------------- | ------------------------------------------------------------------------- |
| Run      | Only for `status: 'draft'`   | `POST /experiments/:id/run` → refetch list                                |
| Complete | Only for `status: 'running'` | `PATCH /experiments/:id` with `{ status: 'completed' }` → refetch list    |
| Delete   | Always (except running)      | `DELETE /experiments/:id` → confirmation dialog → optimistic local remove |

All action buttons show a loading spinner and disable during the request to prevent double-clicks.

**Create form (`CreateExperimentForm`):** collapsed into a "New Experiment" button until clicked, then expands to an inline Card.

| Field       | Notes                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Name        | Required, ≤ 200 chars                                                                                                                     |
| Description | Optional, ≤ 2000 chars                                                                                                                    |
| Agent       | Radix `<Select>` populated from `GET /agents?limit=100`. Empty-agents state shows an amber "create one first" hint                        |
| Variants    | Seeded with `[{ label: 'Variant A' }, { label: 'Variant B' }]`. "Add variant" autonumbers A→E (max 5). Remove disabled when only 2 remain |

Submit is disabled until `name.trim()` and `agentId` are set. `APIClientError` surfaces the server message above the form; generic string otherwise.

Every non-trivial field has a `<FieldHelp>` popover matching the CLAUDE.md contextual-help rule.

## Error handling

| Scenario                        | HTTP | Code                  |
| ------------------------------- | ---- | --------------------- |
| Unauthenticated                 | 401  | `UNAUTHORIZED`        |
| Non-admin                       | 403  | `FORBIDDEN`           |
| Rate limited                    | 429  | `RATE_LIMIT_EXCEEDED` |
| Experiment not found            | 404  | `NOT_FOUND`           |
| Already running/completed       | 400  | `VALIDATION_ERROR`    |
| Invalid status transition       | 400  | `VALIDATION_ERROR`    |
| Delete while running            | 400  | `VALIDATION_ERROR`    |
| < 2 variants on run             | 400  | `VALIDATION_ERROR`    |
| Too few/many variants on create | 400  | `VALIDATION_ERROR`    |
