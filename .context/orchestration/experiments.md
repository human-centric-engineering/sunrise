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
Body: { name?, description? }   — at least one field required
Response 200: { success: true, data: Experiment }
```

### Delete experiment

```
DELETE /api/v1/admin/orchestration/experiments/:id
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
         ↑
    POST /run
```

- Only `draft` experiments can be run.
- Transitioning to `completed` is manual (PATCH) — no automated stop today.

## Variant shape

```typescript
interface ExperimentVariant {
  id: string;
  experimentId: string;
  label: string; // e.g. "Control", "Treatment A"
  agentVersionId?: string | null; // pin to a snapshot; null = current live config
  score?: number | null; // filled in after evaluation
  createdAt: Date;
}
```

## UI — ExperimentsList

`components/admin/orchestration/experiments/experiments-list.tsx`

- Fetches experiments via `apiClient.get` on mount
- Displays status badge, variant count, and (if completed) average score
- **Run** button visible only for `draft` experiments; calls `POST /experiments/:id/run`
- **Delete** button calls `DELETE /experiments/:id` then refreshes list
- **Create form** inline at top of page:
  - Name field (required before submit)
  - Agent selector (Radix Select loaded from `/api/v1/admin/orchestration/agents`)
  - "Add Variant" button (min 2, max 5 variants)
  - "Remove" disabled when only 2 variants remain

## Error handling

| Scenario                        | HTTP | Code                  |
| ------------------------------- | ---- | --------------------- |
| Unauthenticated                 | 401  | `UNAUTHORIZED`        |
| Non-admin                       | 403  | `FORBIDDEN`           |
| Rate limited                    | 429  | `RATE_LIMIT_EXCEEDED` |
| Experiment not found            | 404  | `NOT_FOUND`           |
| Already running/completed       | 400  | `VALIDATION_ERROR`    |
| < 2 variants on run             | 400  | `VALIDATION_ERROR`    |
| Too few/many variants on create | 400  | `VALIDATION_ERROR`    |
