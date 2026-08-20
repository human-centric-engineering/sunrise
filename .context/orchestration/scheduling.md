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

| Field            | Type      | Notes                                                       |
| ---------------- | --------- | ----------------------------------------------------------- |
| `id`             | CUID      | Primary key                                                 |
| `workflowId`     | FK        | Links to `AiWorkflow`                                       |
| `name`           | String    | Human label                                                 |
| `cronExpression` | String    | 5-field cron (`0 9 * * 1-5`)                                |
| `inputTemplate`  | JSON      | Passed as `inputData` on execution                          |
| `scope`          | JSON?     | Static `CapabilityContext.scope` for fired runs (see below) |
| `isEnabled`      | Boolean   | Must be `true` and `nextRunAt <= now`                       |
| `lastRunAt`      | DateTime? | Set after each trigger                                      |
| `nextRunAt`      | DateTime? | Precomputed next fire time (indexed)                        |
| `createdBy`      | FK        | User who created the schedule                               |

Index: `(isEnabled, nextRunAt)` for efficient due-schedule queries.

### Static scope carrier

`AiWorkflowSchedule.scope` and `AiWorkflowTrigger.scope` are optional flat
string→string maps mirroring [`CapabilityContext.scope`](./capabilities.md). When
set, the scope is stamped onto the created `AiWorkflowExecution.scope` (validated
on read via `resolvePersistedScope` in `lib/orchestration/scope.ts` — a malformed
row is dropped to unscoped, never wedging a fire), so capabilities inside the run
can refuse to run outside it. Core names no keys; a fork maps them to its own
domain (e.g. `{ projectId }`). `NULL`/unset = unscoped (unchanged behaviour).

The generic webhook trigger (`POST /api/v1/webhooks/trigger/:slug`) has no
per-trigger config row and is deliberately left unscoped — a scoped event trigger
is expressed through the [inbound-adapter seam](./inbound-triggers.md) instead
(`AiWorkflowTrigger.scope` for static scope, plus an adapter-derived
payload-dependent scope from `normalise()`, static winning on key conflicts).

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
4. Creates `AiWorkflowExecution` with status `pending`, `inputTemplate` as `inputData`, `triggerSource: 'schedule'`, and **`userId: null`** — see [Attribution](#attribution) below
5. Validates the workflow definition via `workflowDefinitionSchema.safeParse()` — marks execution as `failed` if invalid
6. **Invokes the orchestration engine** via `drainEngine()` (fire-and-forget) with `resumeFromExecutionId` so the engine picks up the `pending` row and transitions it through `running` to `completed`/`failed`

Returns `{ processed, succeeded, failed, errors }`.

### Attribution

A scheduled run is **system-owned**: the execution row and the engine context
both carry `userId: null`. A cron tick is not a person doing something, and
`AiWorkflowExecution.userId` is `onDelete: Cascade` — while the row named the
schedule's author, erasing that one account took the organisation's whole
scheduled-run history with it ([#502](https://github.com/human-centric-engineering/sunrise/issues/502)).

`AiWorkflowSchedule.createdBy` still records who set the schedule up, and
`triggerSource: 'schedule'` marks the runs it produced.

Two things follow:

- **Admin visibility comes from the system basis.** Every admin can see and act
  on system-owned runs via `lib/orchestration/access/execution-access.ts`. A new
  surface that compares `userId` to the session id directly will show no
  scheduled runs at all.
- **`judge_call` cannot run on a schedule.** It needs a real account to file the
  judge transcript against and throws `judge_call_requires_user_context`
  instead of borrowing the schedule author's. Grade through the evaluations
  surface, or start the workflow from an admin session.

Runs created before this change kept their author — the scheduler set no
`triggerSource` back then, so they cannot be told apart from runs an admin
started by hand. See the `20260801090000_system_owned_inbound_runs` migration.

**Engine-crash handling.** If the engine throws an uncaught error inside `drainEngine`, `finalize()` never runs — so the engine's normal `workflow.failed` hook is not emitted. To prevent silent zombification, the catch block updates the execution row to `failed` (with `errorMessage`, `completedAt`, AND `leaseToken: null` + `leaseExpiresAt: null` to clear the lease so it doesn't pin a terminal row) and dispatches the crash to **both** notification subsystems: the `workflow.execution.failed` event hook (for code-configured filterable dispatch) and the `execution_crashed` webhook subscription event (for admin-UI-configured durable delivery). Both payloads carry the same sanitised error. Subscribers and `GET /executions/:id/status` see consistent state immediately rather than waiting for the next reaper sweep. The lease-clear is also enforced structurally by the SQL CHECK constraint `ai_workflow_execution_lease_pair_coherent` — see [`engine.md` — Recovery model](./engine.md#recovery-model). See [Hooks — Event Types](./hooks.md#event-types) for the distinction between `workflow.failed` and `workflow.execution.failed`, and the [Webhook UI](../admin/orchestration-webhooks.md) for admin-driven subscription management.

### `processPendingExecutions(staleThresholdMs?)`

Recovery sweep that picks up `AiWorkflowExecution` rows stuck in `pending` status — e.g. due to a crash between row creation and engine invocation.

1. Queries executions where `status = 'pending' AND createdAt < (now - staleThresholdMs)` (default: 2 minutes, max 20 per sweep)
2. Marks `failed` if the linked workflow is inactive or has an invalid definition
3. Otherwise invokes `drainEngine()` fire-and-forget

Called automatically by the unified maintenance tick.

### `processOrphanedExecutions()`

Lease-aware recovery sweep that picks up `AiWorkflowExecution` rows stuck in `running` status whose host died mid-step. See [`engine.md` — Recovery model](./engine.md#recovery-model) for the lease semantics.

1. Queries executions where `status = 'running' AND leaseExpiresAt < now()` (max 20 per sweep)
2. Marks `failed` with `errorMessage = "Recovery exhausted after N attempts"` if `recoveryAttempts >= MAX_RECOVERY_ATTEMPTS` (= 3); also emits `workflow.execution.failed` hook + `execution_crashed` webhook
3. Marks `failed` if the workflow has been deactivated, has no published version, or has an invalid definition
4. Otherwise invokes `drainEngine()` fire-and-forget; the engine's `initRun` claims the lease atomically via `claimLease(executionId, 'orphan-resume')` (the `'orphan-resume'` reason increments `recoveryAttempts` in the same UPDATE — `'fresh-resume'` is the approval-pause variant that does NOT consume a recovery slot) and resumes from `row.currentStep`

Detection latency is `LEASE_DURATION_MS + tick cadence` — typically under 4 minutes after a crash. Returns `{ recovered, exhausted, errors }`.

Called automatically by the unified maintenance tick **before** `reapZombieExecutions`, so any recoverable orphan is re-driven before the 30-minute zombie reaper would mark it failed.

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

`POST /api/v1/admin/orchestration/maintenance/tick` — runs all periodic maintenance tasks in one call. **Returns `202 Accepted`** as soon as `processDueSchedules()` has claimed and fired any due schedules; the remaining eight tasks run as a fire-and-forget background chain inside the same overlap guard and log per-task results when they settle. Each background task also has a minimum interval, so most ticks run only a subset — see the table below.

1. `processDueSchedules()` — workflow cron schedules **(awaited synchronously)**
2. `processPendingRetries()` — webhook subscription delivery retry queue _(background)_
3. `processPendingHookRetries()` — event-hook delivery retry queue _(background)_
4. `processOrphanedExecutions()` — re-drive `running` executions whose lease has expired (lease-aware crash recovery) _(background)_
5. `reapZombieExecutions()` — mark stale `running` executions as `failed`, 30 min threshold (absolute backstop) _(background)_
6. `backfillMissingEmbeddings()` — re-embed messages that failed initial embedding _(background)_
7. `enforceRetentionPolicies()` — delete conversations past per-agent retention window, prune old webhook deliveries and cost log rows _(background)_
8. `processPendingExecutions()` — recover orphaned `pending` workflow executions _(background)_
9. `processPendingEvaluationRuns()` — drive one time-slice of the queued dataset-evaluation runs _(background)_

**Per-task minimum intervals (#442).** The background tasks do **not** all run on every tick. Each declares the shortest gap at which running it can still find work, in `lib/orchestration/maintenance/platform-jobs.ts`:

| Task                       | Interval   | Why                                                                 |
| -------------------------- | ---------- | ------------------------------------------------------------------- |
| `webhookRetries`           | every tick | backoff starts at 10s — a throttle would miss the first retry       |
| `hookRetries`              | every tick | same 10s / 60s / 300s backoff                                       |
| `orphanSweep`              | 2 min      | the lease is 3 min, so a faster sweep provably finds nothing        |
| `zombieReaper`             | 5 min      | its own stale threshold is 30 min                                   |
| `embeddingBackfill`        | 15 min     | best-effort re-embed of a failed write; the anti-join is unindexed  |
| `retention`                | 1 hour     | windows are measured in days                                        |
| `pendingExecutionRecovery` | 2 min      | its own stale-pending threshold is 2 min                            |
| `evaluationRuns`           | every tick | the worker drives one time-slice per tick, so cadence is throughput |

A task held back by its interval reports the string `'skipped'` under its own key in the completion log line — reported rather than omitted, so "did the sweep run?" is answerable from the logs. Intervals are **start-to-start** and held **in process memory**: persisting them would cost a DB round-trip per task per tick, which is the cost the throttle exists to remove. Consequences, both benign because every throttled task is idempotent: each instance in a multi-instance deployment keeps its own clock (so a task runs roughly once per instance per interval), and a restart re-arms everything immediately.

The same table also gives each task an **in-flight latch** — a task still running from an earlier tick is never started a second time, even after the liveness watchdog below releases the overlap guard.

Forks add their own recurring work through `registerAppJob`, which shares the throttle mechanism (`job-clock.ts`) but keeps a separate registry and clock, so a fork job named `retention` cannot throttle Sunrise's sweep — see [App jobs](#app-jobs--the-fork-seam-on-the-tick) below.

**Response shape:**

```jsonc
{
  "success": true,
  "data": {
    "schedules": { "processed": 2, "succeeded": 2, "failed": 0, "errors": [] },
    "backgroundTasks": [
      "webhookRetries",
      "hookRetries",
      "orphanSweep",
      "zombieReaper",
      "embeddingBackfill",
      "retention",
      "pendingExecutionRecovery",
      "evaluationRuns",
    ],
    "durationMs": 47,
  },
}
```

A tick the idle gate skipped returns **200** with `{ skipped: true, reason: 'idle' | 'previous tick still running' }` instead — see below.

The schedules result is concretely reported. Per-task background results are NOT in the response — they are written to the application logger as `Maintenance tick background tasks completed` once the chain settles. This decouples HTTP duration from retention-sweep / embedding-backfill runtime so external cron callers can use a short HTTP timeout (e.g. 30s) without ever cutting off mid-task. Engine work inside `processDueSchedules` was already detached via `void drainEngine`, so the synchronous portion only includes DB-claim work.

### The idle gate — a tick that does no database work at all

Per-task intervals cut how much a tick does; they cannot make it do **nothing**, and nothing is what a scale-to-zero Postgres (Neon, Aurora Serverless v2) needs before it will autosuspend. One query a minute defeats a 5-minute autosuspend timer exactly as effectively as twenty do.

So a sweep that finds nothing arms the **idle gate** (`lib/orchestration/maintenance/idle-gate.ts`), and subsequent ticks return before any Prisma call:

```jsonc
// 200 OK — no database round-trips were made
{
  "success": true,
  "data": { "skipped": true, "reason": "idle", "resumesAt": "2026-07-30T12:30:00.000Z" },
}
```

**Why skipping is sound.** Every latency-critical task's future work is announced by a timestamp column only a _request_ can write — `nextRetryAt` on the two delivery tables (written by the dispatch paths, which also arm the in-process `setTimeout` that does the actual retry; the tick's drain is a crash backstop), `AiWorkflowSchedule.nextRunAt`, a queued evaluation run, a `pending` execution. On a genuinely idle deployment there is no writer, so the state cannot change between ticks.

Three things keep that argument honest:

| Mechanism                   | What it prevents                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The horizon**             | Arming takes the earliest known future work — the next `nextRunAt` (one indexed lookup via `getNextScheduleRunAt`) and the shortest registered app-job interval. A schedule due in 40s still fires in 40s.          |
| **The cap**                 | `MAINTENANCE_IDLE_MAX_SKIP_MS` (default 30 min) bounds how long the gate may skip without re-checking, so a write this process could not observe is picked up within that window rather than never.                 |
| **`noteMaintenanceWork()`** | Request paths that create tick-owned work — delivery retry scheduled, schedule created/edited, evaluation run queued, execution enqueued by a trigger — disarm the gate immediately instead of waiting for the cap. |

The gate refuses to arm at all unless the sweep proved there was nothing to do: any task that found something, any task that **failed**, a fired schedule, an errored schedules sweep, or a failed horizon probe all leave it disarmed. Not knowing the state is precisely the case where skipping is unsafe.

**Tuning.** Lowering the cap does not make schedules more punctual — the horizon already handles that — it only shortens how long an unobservable write can go unnoticed:

- **Single instance on scale-to-zero Postgres:** leave the default, or raise it above your autosuspend timer so the compute can actually idle. This is the setting the feature exists for.
- **Multiple instances:** lower it (5 min is a reasonable choice). Each instance keeps its own gate, so instance A can be armed while instance B takes the write.
- **`MAINTENANCE_IDLE_MAX_SKIP_MS=0`:** gate disabled, every tick sweeps — the pre-#442 behaviour.

State is per-process by necessity: persisting a `lastTickAt` would cost exactly the query per tick the gate exists to remove, and a DB-backed "should I skip?" switch is self-defeating for the same reason. A fresh instance starts **disarmed**, so a cold start always sweeps.

**Forcing a sweep:** `POST …/maintenance/tick?force=1` ignores the gate. It does not bypass the overlap guard, which protects against concurrency rather than repetition. A forced sweep that finds nothing re-arms the gate as usual.

**Overlap protection:** A module-level `tickRunning` flag wraps the **entire** chain — synchronous schedules plus background tasks. If a tick is still running (synchronous _or_ background) when the next cron fires, the endpoint returns `{ skipped: true }` immediately. The guard releases when the background chain settles. A 5-minute liveness watchdog force-releases the guard if the background chain hangs (logs `Maintenance tick: background chain exceeded max duration` as the operational signal), and a per-tick monotonic token prevents a late-settling old chain from accidentally releasing a newer tick's guard. See [Resilience — Maintenance Tick Overlap Protection](./resilience.md#maintenance-tick-overlap-protection) for the full discussion.

**Deployment:** Configure one external cron to call this endpoint every 60 seconds:

```bash
* * * * * curl -s -X POST -H "Authorization: Bearer sk_..." https://your-app/api/v1/admin/orchestration/maintenance/tick
```

#### Cadence on a scale-to-zero database

If your Postgres autosuspends when idle (Neon, Aurora Serverless v2, paused Supabase), the tick used to bill you for a database that was never allowed to sleep: it did a fixed amount of work every 60 seconds whether or not there was anything to do, and autosuspend keys off compute idle time, so **one** query a minute defeats a 5-minute timer exactly as effectively as twenty. A deployment with near-zero traffic was billed as if it ran continuously — ~730 h/month.

The idle gate above is the fix, and it works at the documented 60s cadence: the ticks still fire, they just cost nothing. Keep `* * * * *` and you get punctual workflow schedules **and** an idle database.

Slow the cron down only for the _other_ cost — one serverless invocation per minute:

```bash
*/5 * * * * curl -s -X POST -H "Authorization: Bearer sk_..." https://your-app/api/v1/admin/orchestration/maintenance/tick
```

State the price plainly before choosing this: **a workflow schedule can only be as punctual as the cron that drives it.** At `*/5`, a schedule set to run every minute fires every five, and any schedule fires up to 5 minutes late. Nothing is lost — the sweeps are idempotent and catch up on the next fire — but "why did my 9:00 report arrive at 9:04?" has this as its answer.

Checklist for a scale-to-zero deployment:

| Setting                        | Value                                                         |
| ------------------------------ | ------------------------------------------------------------- |
| Cron cadence                   | `* * * * *` — the gate makes idle ticks free                  |
| `MAINTENANCE_IDLE_MAX_SKIP_MS` | default (30 min), or above your autosuspend timer             |
| Instances                      | one, or lower the cap — each instance keeps its own gate      |
| Admin tabs left open           | fine — `useHealthCheck` pauses `SELECT 1` polling when hidden |

Verify it works the way any query-count claim should be verified — enable Prisma query logging and watch an idle deployment. After the first sweep arms the gate you should see **no** queries until the horizon, then one short burst.

**Dev-only in-process ticker.** `instrumentation.ts` arms a 60s `setInterval` that calls `runMaintenanceTick()` directly when `NODE_ENV === 'development'` (first fire ~3s after server startup, after the dev compile warm-up). This is dev-only because production deploys an external cron that is authoritative and survives serverless cold starts; the dev ticker just prevents the "I queued an eval run, why didn't it move?" friction. Opt out with `SUNRISE_DISABLE_DEV_TICK=1` when you want to test the manual flow. The HTTP route and the dev ticker share the same body (`lib/orchestration/maintenance/run-tick.ts`) so the overlap guard, watchdog, and task chain stay identical across both callers.

**Operational note — log message change.** The previous synchronous tick wrote a single `Maintenance tick completed` log line containing all per-task results. With background execution, the per-task results are now written from the background chain's `.then()` as `Maintenance tick background tasks completed` once the chain settles. Any log-based dashboard or alert keyed on the old `Maintenance tick completed` string needs to be updated to match the new message before relying on it. The synchronous response itself only carries the `schedules` result and the `backgroundTasks` name list — see the response shape above.

### Webhook Trigger (API key auth required)

`POST /api/v1/webhooks/trigger/:slug` — starts a workflow execution using the request body as input. Requires a bearer token with the `webhook` scope (or `admin`). Only active workflows can be triggered.

The `:slug` parameter is validated against `slugSchema` (lowercase alphanumeric + hyphens, max 100 chars). Malformed slugs return `400 VALIDATION_ERROR` before reaching the database.

Authentication: `Authorization: Bearer sk_...` header. Create keys with `scopes: ["webhook"]` via `POST /api/v1/user/api-keys`. Per-key rate limiting is supported via the `rateLimitRpm` field on `AiApiKey` — when set, it overrides the global rate limit for that key.

Returns `{ executionId, workflowId, workflowSlug, status: 'pending' }` with status 201.

### Inbound Triggers (channel-specific signature auth)

For senders that can't issue an `Authorization: Bearer sk_…` API-key header — Slack, Postmark inbound parse, generic-HMAC senders — use the inbound-triggers route family at `POST /api/v1/inbound/:channel/:slug` instead. Each channel ships with a verified signature scheme (Slack signing-secret HMAC, Postmark Basic auth, generic HMAC over body) and a normalised payload shape so workflow templates reference fields like `{{ trigger.event.text }}` (Slack) or `{{ trigger.from.email }}` (Postmark).

The webhook-trigger endpoint above stays appropriate when YOU control the sender (internal services, Zapier/n8n/Make, your own automation): one bearer token, opaque body. The inbound-triggers route is for **named third-party systems** where the signature scheme is dictated by the vendor and per-channel payload normalisation matters.

See [Inbound triggers](./inbound-triggers.md) for the full guide — quick-start per channel, normalised payload tables, replay-protection model, and the adapter authoring contract.

## Validation Schemas

- `createScheduleSchema` — `name` (required), `cronExpression` (required), `inputTemplate` (optional JSON), `isEnabled` (optional boolean), `scope` (optional flat string→string map)
- `updateScheduleSchema` — all fields optional; `scope` accepts `null` to clear (persisted via the `Prisma.DbNull` sentinel)

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

Full CRUD for webhooks is available at `/admin/orchestration/event-subscriptions` (page label: "Event Subscriptions"). See [Webhook Management UI](../admin/orchestration-webhooks.md).

## App jobs — the fork seam on the tick

Forks that need their own periodic work register it on the existing maintenance
tick rather than standing up a second scheduler.

`lib/orchestration/maintenance/app-jobs.ts` holds the registry;
`lib/app/jobs.ts` is the fork-owned scaffold that fills it (ships empty, so
vanilla Sunrise pays nothing — `runDueAppJobs()` short-circuits on an empty
registry).

```typescript
// lib/app/jobs.ts
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';

export function initAppJobs(): void {
  registerAppJob({
    name: 'app:prune-draft-invoices',
    intervalMs: 6 * 60 * 60 * 1000,
    run: async () => ({ pruned: await pruneDrafts() }),
  });
}
```

| Export                | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `registerAppJob(job)` | Register. Idempotent by `name` — re-registering replaces.       |
| `getAppJobs()`        | Registered jobs in first-registration order (admin surface).    |
| `runDueAppJobs(now?)` | Called by the tick. Returns a per-job summary for its log line. |

Semantics — the first three are shared with the platform's own tasks, which use
the same `job-clock.ts` mechanism (#442):

- **`intervalMs` is a minimum gap, not a guarantee.** Last-run times are
  in-process, so a multi-instance deployment runs each job about once per
  instance per interval and a restart re-arms everything. Jobs must be
  idempotent. Exactly-once cluster-wide needs a lease — see `execution-reaper`.
- **The clock is start-to-start.** `lastRunAt` is stamped before `run()`, not
  after.
- **A job still in flight is skipped**, however long ago it became due, so a job
  slower than its own interval cannot stack up concurrent runs.
- **`intervalMs` that is non-positive or `NaN` is refused at registration** and
  logged, rather than defaulted to something that would run every tick.
- **Failures are contained.** Jobs run in parallel; a rejection is logged, folded
  into the summary as `{ error }`, and does not affect the tick or other jobs.
- **`initAppJobs()` runs once, lazily, latched before it runs** — a throwing init
  degrades to "no app jobs" instead of retrying every tick, and jobs registered
  **before** the throw are rolled back. Without that, a job registered before the
  throw ran on every tick forever from a config its author believed had not
  loaded, and held the idle gate open at its own interval — a permanent cost, not
  a one-off. See [Fork Init Seams](../architecture/fork-init-seams.md).

Jobs not yet due are reported as `skipped: <count>` in the summary, so the
cadence is visible in the tick log rather than inferred from silence.

See [`CUSTOMIZATION.md` §4](../../CUSTOMIZATION.md#4-configuration--environment--the-libapp-surface).

## Retention Pruning

`enforceRetentionPolicies()` in `lib/orchestration/retention.ts` handles five types of cleanup:

1. **Conversation retention** — per-agent `retentionDays` field. Conversations whose `updatedAt` exceeds the window are cascade-deleted (messages, embeddings, cost logs).
2. **Webhook subscription delivery pruning** — `pruneWebhookDeliveries()` reads `webhookRetentionDays` from the global `AiOrchestrationSettings` singleton. Skips if null.
3. **Event-hook delivery pruning** — `pruneHookDeliveries()` shares the same `webhookRetentionDays` setting — event-hook deliveries are the same class of dispatch-audit data as subscription deliveries. Skips if null.
4. **Cost log pruning** — `pruneCostLogs()` reads `costLogRetentionDays` from the same settings row. Skips if null.
5. **Admin audit log pruning** — `pruneAuditLogs()` reads `auditLogRetentionDays` from the same settings row. Skips if null (the default — the audit trail is immutable unless operators opt in).

All four prune functions accept an optional `maxAgeDays` parameter to override the settings lookup. Configure retention via the admin settings API (`PATCH /api/v1/admin/orchestration/settings`).
