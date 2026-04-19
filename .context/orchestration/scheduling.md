# Scheduling & Webhooks

Cron-based scheduling and webhook triggers for automated workflow execution. Lives in `lib/orchestration/scheduling/`.

## Module Layout

```
lib/orchestration/scheduling/
├── scheduler.ts   # getNextRunAt(), isValidCron(), processDueSchedules()
└── index.ts       # barrel exports
```

## Data Model

`AiWorkflowSchedule` — stored in `ai_workflow_schedule`:

| Field            | Type      | Notes                                 |
| ---------------- | --------- | ------------------------------------- |
| `id`             | CUID      | Primary key                           |
| `workflowId`     | FK        | Links to `AiWorkflow`                 |
| `name`           | String    | Human label                           |
| `cronExpression` | String    | 5-field cron (`0 9 * * 1-5`)          |
| `inputTemplate`  | JSON      | Passed as `inputData` on execution    |
| `isEnabled`      | Boolean   | Must be `true` and `nextRunAt <= now` |
| `lastRunAt`      | DateTime? | Set after each trigger                |
| `nextRunAt`      | DateTime? | Precomputed next fire time (indexed)  |
| `createdBy`      | FK        | User who created the schedule         |

Index: `(isEnabled, nextRunAt)` for efficient due-schedule queries.

## Scheduler Service

### `getNextRunAt(cronExpression, from?)`

Computes the next fire time using `cron-parser` v5 (`CronExpressionParser.parse`). Returns `null` for invalid expressions.

### `isValidCron(cronExpression)`

Returns `true` if the expression parses without error.

### `processDueSchedules()`

Called every ~60 seconds by an external cron job hitting `POST /api/v1/admin/orchestration/schedules/tick`.

1. Queries enabled schedules where `nextRunAt <= now` (max 50 per tick)
2. Skips schedules whose workflow is inactive
3. Atomically updates `lastRunAt` and `nextRunAt` before creating execution (prevents double-fire)
4. Creates `AiWorkflowExecution` with status `pending` and `inputTemplate` as `inputData`

Returns `{ processed, succeeded, failed, errors }`.

## API Endpoints

### Schedule CRUD (admin-auth required)

| Method   | Path                                                              | Description                 |
| -------- | ----------------------------------------------------------------- | --------------------------- |
| `GET`    | `/api/v1/admin/orchestration/workflows/:id/schedules`             | List schedules for workflow |
| `POST`   | `/api/v1/admin/orchestration/workflows/:id/schedules`             | Create schedule             |
| `GET`    | `/api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId` | Get single schedule         |
| `PATCH`  | `/api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId` | Update schedule             |
| `DELETE` | `/api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId` | Delete schedule             |

### Scheduler Tick (admin-auth required)

`POST /api/v1/admin/orchestration/schedules/tick` — calls `processDueSchedules()`. Legacy single-purpose endpoint.

### Unified Maintenance Tick (admin-auth required, **preferred**)

`POST /api/v1/admin/orchestration/maintenance/tick` — runs all periodic maintenance tasks in one call:

1. `processDueSchedules()` — workflow cron schedules
2. `processPendingRetries()` — webhook delivery retry queue
3. `reapZombieExecutions()` — mark stale `running` executions as `failed` (30 min threshold)
4. `backfillMissingEmbeddings()` — re-embed messages that failed initial embedding
5. `enforceRetentionPolicies()` — delete conversations past per-agent retention window

Each function runs via `Promise.allSettled` — individual failures don't block others. Results are returned per-function.

**Deployment:** Configure one external cron to call this endpoint every 60 seconds:

```bash
* * * * * curl -s -X POST -H "Authorization: Bearer sk_..." https://your-app/api/v1/admin/orchestration/maintenance/tick
```

### Webhook Trigger (API key auth required)

`POST /api/v1/webhooks/trigger/:slug` — starts a workflow execution using the request body as input. Requires a bearer token with the `webhook` scope (or `admin`). Only active workflows can be triggered.

Authentication: `Authorization: Bearer sk_...` header. Create keys with `scopes: ["webhook"]` via `POST /api/v1/user/api-keys`. Per-key rate limiting is supported via the `rateLimitRpm` field on `AiApiKey` — when set, it overrides the global rate limit for that key.

Returns `{ executionId, workflowId, workflowSlug, status: 'pending' }` with status 201.

## Validation Schemas

- `createScheduleSchema` — `name` (required), `cronExpression` (required), `inputTemplate` (optional JSON), `isEnabled` (optional boolean)
- `updateScheduleSchema` — all fields optional

Both defined in `lib/validations/orchestration.ts`.

## Cron Expression Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

Examples:

- `0 9 * * *` — daily at 9:00
- `*/5 * * * *` — every 5 minutes
- `0 9 * * 1-5` — weekdays at 9:00
- `0 0 1 * *` — first of each month at midnight

Parsed by `cron-parser` v5 (`CronExpressionParser`).
