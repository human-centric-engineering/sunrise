# Live Engine — admin surface for stuck-execution visibility

URL: `/admin/orchestration/executions` (the dashboard cards render
above the executions list on the same page).
Legacy URL: `/admin/orchestration/executions/live` — preserved as a
permanent 308 redirect to `/admin/orchestration/executions` so existing
sidebar bookmarks, Slack alerts, and partner-shared links keep working.
Role: any user with `role = 'admin'`
Polling cadence: 5 seconds while the tab is in the foreground (paused on
`document.hidden` via the shared `useAutoRefresh` hook).

This is the operator's first stop when a partner says "my workflow has
been running for 20 minutes." It is paired with two changes on the
executions list — a sortable **Step age** column with stuck-threshold
highlighting, and a per-row **Force fail** action — and a **Lease
inspector** drill-in surfacing the lease event history that PR #202
alone could not.

**Why on the executions page and not a separate route?** The cards
summarise the rows below them and link into filter states. Keeping
them adjacent removes the navigation step the original separate-page
design required ("notice a stuck row on /live, click into /executions,
find the row, force-fail"). Cards on the executions page push
`?status=<X>` via `router.replace` (shallow, no nav) and the table
listens for the change and refetches. One URL, one mental model.

## The four cards

Each card is computed inside `getLiveEngineSnapshot()`
(`lib/orchestration/admin/live-engine-snapshot.ts`) — one batched read
that fans four index-friendly Prisma queries in parallel. The route
(`GET /api/v1/admin/orchestration/executions/live`) is a thin
`withAdminAuth` + `adminLimiter` envelope on top.

| Card                   | Computation                                                                                                                                                                                                                                                                                             | Drill-in                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Running**            | `count(AiWorkflowExecution WHERE status='running')` + p95/max of `now - MIN(AiWorkflowRunningStep.startedAt WHERE completedAt IS NULL)` per execution (oldest branch wins for parallel fan-out, sample capped at 500)                                                                                   | Links to `/admin/orchestration/executions?status=running`    |
| **Pending**            | `count(WHERE status='pending')` + `now - MIN(createdAt)` of pending rows. Card label matches the `Pending` status used in the executions filter dropdown and badges — earlier drafts called this "Queued" but the inconsistency confused operators reading the dashboard count against the list filter. | Links to `?status=pending`                                   |
| **Orphaned**           | `count(WHERE status='running' AND leaseExpiresAt < now)`. Strict subset of Running — the dashboard does NOT subtract; both numbers are shown as-is and the doc here is the source of truth on the relationship                                                                                          | Links to `?status=running`. Card border goes amber when > 0. |
| **Provider in-flight** | In-memory per-process counter (`lib/orchestration/llm/in-flight-counter.ts`) read via the `track()` / `trackStream()` proxy wrap installed in `getProvider()`. Counts live calls to `chat`, `chatStream`, `embed`, `transcribe` — NOT admin metadata like `listModels` / `testConnection`.              | None — counts are process-local.                             |

**Scoping.** The three execution-row cards (Running, Queued, Orphaned) are scoped to the authenticated admin's `userId` so the numbers match what the executions list, force-fail, and lease inspector routes — all of which gate on `userId === session.user.id` — will let them act on. Without that match an admin would see "5 running" on the dashboard but find only 2 on their own list, with no way to drill into the other 3. The Provider in-flight card is process-wide on purpose: the in-flight counter has no user attribution at the proxy boundary, and operators read it as "the worker my admin tab hit is currently handling N calls." For a genuinely global "is the engine healthy?" lens across users, see priorities-doc #41 (Workflow-execution health dashboard) — explicitly a separate concern.

The bottom of the page shows the snapshot's `generatedAt` plus the
poll interval. On a transient fetch failure the last-good snapshot
stays visible and a red banner names the error — the page does not
crash or zero out on a single flaky poll.

## The Step age column on the executions list

The list endpoint (`GET /api/v1/admin/orchestration/executions`) now
returns a `timeInCurrentStepMs: number | null` per row, computed from
the same `AiWorkflowRunningStep` side table (PR #202) the live snapshot
uses. Non-running rows always get `null`. For parallel fan-out the
oldest branch's start time wins so the displayed age reflects "how long
has this been stuck" rather than the freshest sibling.

The threshold for highlighting comes from the `stuckExecutionThresholdMins`
column on `AiOrchestrationSettings` (default 5, clamped to `[1, 1440]`
on both read and write). Operators can change it from the Settings page
under **Limits → Stuck execution threshold**. A row whose
`timeInCurrentStepMs ≥ threshold * 60_000` gets an amber background
plus a `⚠` icon in the column.

## Force fail

`POST /api/v1/admin/orchestration/executions/[id]/force-fail` accepts
`{ reason?: string (max 500) }`. The route:

1. Conditional `updateMany` WHERE id AND `status IN ('running','pending','paused_for_approval')`
   SET `status='failed'`, `completedAt=now`, `errorMessage`, `leaseToken=null`,
   `leaseExpiresAt=null`. Concurrent natural completion wins via `count: 0` → 409.
2. In the same transaction: `deleteMany` on `AiWorkflowRunningStep` for
   the execution (mirrors `/cancel`).
3. `recordForceFailEvent()` appends a `force-failed` row to
   `AiWorkflowExecutionLeaseEvent` (visible in the inspector).
4. `logAdminAction({ action: 'execution.force_failed' })` — captured in
   the admin audit log with the actor, the previous status, and the
   optional reason.
5. Emits **both** `workflow.failed` (with `source: 'admin-force-fail'`)
   and `execution.force_failed`. Two hooks on purpose — see below.

The UI surfaces this as a per-row dropdown menu item (disabled on
terminal statuses) → confirmation `AlertDialog` with an optional
reason textarea → server error text appears inline on conflict.

### Why two hook events

Partners already have Slack / PagerDuty wired up to `workflow.failed`.
Replacing it with a new event would silently break those integrations
on the first force-fail. Subscribers that want to _distinguish_ admin
termination from natural failure can additionally subscribe to
`execution.force_failed` (or sniff `source: 'admin-force-fail'` on the
existing event). See `.context/orchestration/hooks.md` for the event
table.

## Lease inspector

`GET /api/v1/admin/orchestration/executions/[id]/lease` returns the
current lease state on the execution row + the last 50 rows of
`AiWorkflowExecutionLeaseEvent` (newest first). The UI is a modal
`<LeaseInspectorDialog>` triggered from the executions table row
menu.

**Token redaction.** Tokens are write-capability secrets — anyone
holding one can write to the row via the engine's `where: { id,
leaseToken }` paths. The route applies `redactLeaseToken()` (last 5
chars prefixed `…`) before serialising, and the events table stores
only the redacted tail (never the full token). Operators correlate by
tail; that's enough to answer "is the same host still driving this?"

**What the events mean.** From `lib/orchestration/engine/lease.ts`:

| Event            | Written when                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`        | `claimLease(reason='fresh-resume')` succeeded — clean state-machine transition.                                                                                                                                                                                                                                                                                                                                                                    |
| `orphan-resume`  | `claimLease(reason='orphan-resume')` succeeded — orphan sweep re-claimed an expired lease.                                                                                                                                                                                                                                                                                                                                                         |
| `refresh-failed` | `refreshLease()` saw a token mismatch — another host has taken the row.                                                                                                                                                                                                                                                                                                                                                                            |
| `released`       | Engine cleared the lease as part of a terminal write. `reason` field distinguishes call sites: `engine-terminal` (normal `finalize()`), `crash-repair` (`drainEngine` catch block), `recovery-exhausted` (past `MAX_RECOVERY_ATTEMPTS`), `workflow-deactivated` / `no-published-version` / `invalid-definition` (the other three orphan-resume sweep paths), `reaper-sweep` (`metadata.kind` = `zombie` / `stale-pending` / `abandoned-approval`). |
| `force-failed`   | Admin force-fail route terminated the row.                                                                                                                                                                                                                                                                                                                                                                                                         |

Every successful claim has a matching termination event in the
inspector — operators can answer "did this run complete cleanly, get
recovered, get reaped, or get killed?" by reading a single timeline.

Successful `refreshLease` calls are deliberately not recorded — they
would dominate the table at roughly one event per minute per running
row, drowning out the transitions that actually matter.

## Settings

The Settings page (`/admin/orchestration/settings`) exposes the threshold
in the **Limits** group:

> **Stuck execution threshold (minutes).** Rows on the executions list
> are flagged when the current step has been running longer than this
> many minutes. The live engine dashboard uses the same number.
> Default 5. Minimum 1, maximum 1440.

PATCH validation lives in `lib/validations/orchestration.ts`; the read
path clamps defensively (`clampStuckThreshold` in `lib/orchestration/settings.ts`)
so a row written by seed / migration / direct SQL outside the bounds
still produces a sensible value.

## Future work

- **SSE aggregator instead of poll.** Today every admin watching the
  live page polls four small queries every 5 s. At one or two
  concurrent admins this is cheap; past that it justifies an in-process
  singleton aggregator that produces the snapshot once per tick and
  pushes via `sseResponse()` (`lib/api/sse.ts`) to all subscribers.
- **Lease event retention.** The table is append-only and currently has
  no prune. Once event volume becomes meaningful, add a
  `LEASE_EVENT_RETENTION_DAYS` setting and a maintenance-tick pass that
  deletes rows past the window.
- **Per-workflow filtering on the live page.** The cards are currently
  global; partner-multi-tenancy or noisy-neighbour debugging would
  benefit from a workflow-id filter.
