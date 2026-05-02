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

**Engine-crash handling.** If the engine throws an uncaught error inside `drainEngine`, `finalize()` never runs — so the engine's normal `workflow.failed` hook is not emitted. To prevent silent zombification, the catch block updates the execution row to `failed` (with `errorMessage` and `completedAt`) and emits a `workflow.execution.failed` hook event. Subscribers and `GET /executions/:id/status` see consistent state immediately rather than waiting for the next reaper sweep. See [Hooks — Event Types](./hooks.md#event-types) for the distinction between `workflow.failed` and `workflow.execution.failed`.

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

**Constraints:** Maximum 10 schedules per workflow. Workflow must be active (`isActive: true`) to create schedules. Create, update, and delete operations are audit-logged via `logAdminAction`.

### Scheduler Tick (admin-auth required)

`POST /api/v1/admin/orchestration/schedules/tick` — calls `processDueSchedules()`. Legacy single-purpose endpoint.

### Unified Maintenance Tick (admin-auth required, **preferred**)

`POST /api/v1/admin/orchestration/maintenance/tick` — runs all periodic maintenance tasks in one call. **Returns `202 Accepted`** as soon as `processDueSchedules()` has claimed and fired any due schedules; the remaining six tasks run as a fire-and-forget background chain inside the same overlap guard and log per-task results when they settle.

1. `processDueSchedules()` — workflow cron schedules **(awaited synchronously)**
2. `processPendingRetries()` — webhook subscription delivery retry queue _(background)_
3. `processPendingHookRetries()` — event-hook delivery retry queue _(background)_
4. `reapZombieExecutions()` — mark stale `running` executions as `failed`, 30 min threshold _(background)_
5. `backfillMissingEmbeddings()` — re-embed messages that failed initial embedding _(background)_
6. `enforceRetentionPolicies()` — delete conversations past per-agent retention window, prune old webhook deliveries and cost log rows _(background)_
7. `processPendingExecutions()` — recover orphaned `pending` workflow executions _(background)_

**Response shape:**

```jsonc
{
  "success": true,
  "data": {
    "schedules": { "processed": 2, "succeeded": 2, "failed": 0, "errors": [] },
    "backgroundTasks": [
      "webhookRetries",
      "hookRetries",
      "zombieReaper",
      "embeddingBackfill",
      "retention",
      "pendingExecutionRecovery",
    ],
    "durationMs": 47,
  },
}
```

The schedules result is concretely reported. Per-task background results are NOT in the response — they are written to the application logger as `Maintenance tick background tasks completed` once the chain settles. This decouples HTTP duration from retention-sweep / embedding-backfill runtime so external cron callers can use a short HTTP timeout (e.g. 30s) without ever cutting off mid-task. Engine work inside `processDueSchedules` was already detached via `void drainEngine`, so the synchronous portion only includes DB-claim work.

**Overlap protection:** A module-level `tickRunning` flag wraps the **entire** chain — synchronous schedules plus background tasks. If a tick is still running (synchronous _or_ background) when the next cron fires, the endpoint returns `{ skipped: true }` immediately. The guard releases when the background chain settles. See [Resilience](./resilience.md#maintenance-tick-overlap-protection).

**Deployment:** Configure one external cron to call this endpoint every 60 seconds:

```bash
* * * * * curl -s -X POST -H "Authorization: Bearer sk_..." https://your-app/api/v1/admin/orchestration/maintenance/tick
```

### Webhook Trigger (API key auth required)

`POST /api/v1/webhooks/trigger/:slug` — starts a workflow execution using the request body as input. Requires a bearer token with the `webhook` scope (or `admin`). Only active workflows can be triggered.

The `:slug` parameter is validated against `slugSchema` (lowercase alphanumeric + hyphens, max 100 chars). Malformed slugs return `400 VALIDATION_ERROR` before reaching the database.

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

**Timezone:** All cron expressions are evaluated in the server's system timezone (typically UTC in production). There is no per-schedule timezone override. If the server timezone changes (e.g., during a migration), existing schedules will shift accordingly. Plan cron expressions in UTC to avoid ambiguity.

## Webhook SSRF Protection

Webhook subscription URLs are validated via Zod schema refinements that call `checkSafeProviderUrl()` from `lib/security/safe-url.ts`. This prevents admins from pointing webhooks at internal services (RFC1918 ranges, cloud metadata endpoints like `169.254.169.254`, etc.). Validation runs on both `POST /webhooks` (create) and `PATCH /webhooks/:id` (update, if URL is present).

## Webhook Management UI

Full CRUD for webhooks is available at `/admin/orchestration/webhooks`. See [Webhook Management UI](../admin/orchestration-webhooks.md).

## Retention Pruning

`enforceRetentionPolicies()` in `lib/orchestration/retention.ts` handles five types of cleanup:

1. **Conversation retention** — per-agent `retentionDays` field. Conversations whose `updatedAt` exceeds the window are cascade-deleted (messages, embeddings, cost logs).
2. **Webhook subscription delivery pruning** — `pruneWebhookDeliveries()` reads `webhookRetentionDays` from the global `AiOrchestrationSettings` singleton. Skips if null.
3. **Event-hook delivery pruning** — `pruneHookDeliveries()` shares the same `webhookRetentionDays` setting — event-hook deliveries are the same class of dispatch-audit data as subscription deliveries. Skips if null.
4. **Cost log pruning** — `pruneCostLogs()` reads `costLogRetentionDays` from the same settings row. Skips if null.
5. **Admin audit log pruning** — `pruneAuditLogs()` reads `auditLogRetentionDays` from the same settings row. Skips if null (the default — the audit trail is immutable unless operators opt in).

All four prune functions accept an optional `maxAgeDays` parameter to override the settings lookup. Configure retention via the admin settings API (`PATCH /api/v1/admin/orchestration/settings`).
