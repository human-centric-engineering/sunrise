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
3. Claims the schedule via **optimistic lock**: `updateMany WHERE id = :id AND nextRunAt = :originalNextRunAt` — if `count === 0`, another tick already claimed it (prevents double-fire in multi-instance deployments)
4. Creates `AiWorkflowExecution` with status `pending` and `inputTemplate` as `inputData`
5. Validates the workflow definition via `workflowDefinitionSchema.safeParse()` — marks execution as `failed` if invalid
6. **Invokes the orchestration engine** via `drainEngine()` (fire-and-forget) with `resumeFromExecutionId` so the engine picks up the `pending` row and transitions it through `running` to `completed`/`failed`

Returns `{ processed, succeeded, failed, errors }`.

### `processPendingExecutions(staleThresholdMs?)`

Recovery sweep that picks up `AiWorkflowExecution` rows stuck in `pending` status — e.g. due to a crash between row creation and engine invocation.

1. Queries executions where `status = 'pending' AND createdAt < (now - staleThresholdMs)` (default: 2 minutes, max 20 per sweep)
2. Marks `failed` if the linked workflow is inactive or has an invalid definition
3. Otherwise invokes `drainEngine()` fire-and-forget

Called automatically by the unified maintenance tick.

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
5. `enforceRetentionPolicies()` — delete conversations past per-agent retention window, prune old webhook deliveries and cost log rows
6. `processPendingExecutions()` — recover orphaned `pending` workflow executions

Each function runs via `Promise.allSettled` — individual failures don't block others. Results are returned per-function.

**Overlap protection:** A module-level `tickRunning` flag prevents concurrent execution. If a tick is still running when the next cron fires, the endpoint returns `{ skipped: true }` immediately. See [Resilience](./resilience.md#maintenance-tick-overlap-protection).

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

## Webhook SSRF Protection

Webhook subscription URLs are validated via Zod schema refinements that call `checkSafeProviderUrl()` from `lib/security/safe-url.ts`. This prevents admins from pointing webhooks at internal services (RFC1918 ranges, cloud metadata endpoints like `169.254.169.254`, etc.). Validation runs on both `POST /webhooks` (create) and `PATCH /webhooks/:id` (update, if URL is present).

## Webhook Management UI

Full CRUD for webhooks is available at `/admin/orchestration/webhooks`. See [Webhook Management UI](../admin/orchestration-webhooks.md).

## Retention Pruning

`enforceRetentionPolicies()` in `lib/orchestration/retention.ts` handles four types of cleanup:

1. **Conversation retention** — per-agent `retentionDays` field. Conversations whose `updatedAt` exceeds the window are cascade-deleted (messages, embeddings, cost logs).
2. **Webhook delivery pruning** — `pruneWebhookDeliveries()` reads `webhookRetentionDays` from the global `AiOrchestrationSettings` singleton. Skips if null.
3. **Cost log pruning** — `pruneCostLogs()` reads `costLogRetentionDays` from the same settings row. Skips if null.
4. **Admin audit log pruning** — `pruneAuditLogs()` reads `auditLogRetentionDays` from the same settings row. Skips if null (the default — the audit trail is immutable unless operators opt in).

All three prune functions accept an optional `maxAgeDays` parameter to override the settings lookup. Configure retention via the admin settings API (`PATCH /api/v1/admin/orchestration/settings`).
