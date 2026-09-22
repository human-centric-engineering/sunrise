# Data Retention & Pruning

How Sunrise automatically deletes aged operational data. Pruning is enforced by
two sweeps in `lib/orchestration/retention.ts` (the windows they prune on are
resolved in `lib/orchestration/retention-windows.ts`), each a task of the unified
maintenance tick (`POST /api/v1/admin/orchestration/maintenance/tick`, called
~every 60s by an external cron) and each throttled to **at most once an hour**
per process, since every window here is measured in days — see
[per-task minimum intervals](./scheduling.md#unified-maintenance-tick-admin-auth-required-preferred):

- **`enforceRetentionPolicies()`** — the tenant sweep (task `retention`). Every
  table it prunes is tenant-owned, so it runs **once per org, inside that org's
  tenant context** (§108): at `TENANCY_MODE=multi` each prune is confined to
  the org's rows by the `org_isolation` policies; at `single` the one org is the
  install org and the sweep behaves as it always did.
- **`enforceSystemRetentionPolicies()`** — the system sweep (task
  `auditLogRetention`). The admin audit log and the MCP audit log have no org
  column, so they are pruned **once, under the audited system scope**, rather
  than N times.

This is the **scheduled-purge** half of the platform's data lifecycle; on-demand
subject erasure is separate — see
[Account Deletion & Right to Erasure](../privacy/data-erasure.md).

## What gets pruned

| Data                                                                                         | Window setting                       | Owner           | Notes                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | --------------- | ----------------------------------------------- |
| Conversations (+ messages, embeddings, cost logs, shares)                                    | `AiAgent.retentionDays`              | per-agent       | `null` = keep forever. Pruned by `updatedAt`.   |
| Webhook deliveries (non-DLQ)                                                                 | `webhookRetentionDays`               | global settings |                                                 |
| Webhook DLQ (`exhausted`)                                                                    | `webhookDlqRetentionDays`            | global settings | Falls back to `webhookRetentionDays` when null. |
| Event-hook deliveries                                                                        | `webhookRetentionDays`               | global settings | Same class as webhook deliveries.               |
| Cost logs                                                                                    | `costLogRetentionDays`               | global settings | Must be ≥ `executionRetentionDays` — see below. |
| **Workflow executions** (+ steps, dispatches, lease events, per-step cost, inbound payloads) | `executionRetentionDays`             | global settings | **Terminal only** — see below.                  |
| **Evaluation history** (`AiEvaluationSession` / `Run` + their logs/cases)                    | `evaluationRetentionDays`            | global settings | **Terminal only** — see below.                  |
| Admin audit logs _(system sweep)_                                                            | `auditLogRetentionDays`              | global settings | Max 3650 days (10y) for compliance regimes.     |
| MCP audit logs _(system sweep)_                                                              | `McpServerConfig.auditRetentionDays` | MCP config      | **Always on** (default 90) — see below.         |

Every global window is **nullable: `null` = keep forever** (skip that prune).
The two retention columns added for executions and evaluations live on
`AiOrchestrationSettings` and are editable in the admin Settings → Retention card.

The five windows the tenant sweep uses are **defaults an org can override** —
see below. The two on the system sweep cannot be: those rows have no org.

## Per-org windows

An org may keep its history on its own schedule (§108 t-713). The five windows
the tenant sweep reads are stored per org in `Org.settings.retention`, and the
global row is what an org that sets nothing gets:

```json
{ "retention": { "executionRetentionDays": 365, "webhookRetentionDays": null } }
```

| In the slice                  | Effect                                                 |
| ----------------------------- | ------------------------------------------------------ |
| key **absent**                | inherit the global window                              |
| key set to a **number**       | that window, for this org                              |
| key set to **`null`**         | what `null` means for that column globally — see below |
| slice absent, `{}`, or `null` | the org is on every global window                      |

`null` means **keep that class forever** for four of the five keys. The
exception is `webhookDlqRetentionDays`, where a null window means "use
`webhookRetentionDays`" — the fallback in the first table, which preserves
pre-DLQ behaviour for installs that never set the column. So nulling the DLQ
window prunes dead-lettered rows on the org's _webhook_ window rather than
keeping them, and neither level can currently express "prune deliveries but
never the DLQ".

Precedence is **per key**, so an org that lengthens its execution window still
follows the platform on everything else — including the DLQ window, which is
not shortened by overriding `webhookRetentionDays` beside it _unless_ the DLQ
window is null at both levels, in which case the fallback above applies and the
webhook window governs both.

**Five keys, not six.** `auditLogRetentionDays` prunes `AiAdminAuditLog`, a
system model with no `orgId` that the system sweep owns: rows nobody owns
cannot be kept per owner. `McpServerConfig.auditRetentionDays` is the same
shape. `AiAgent.retentionDays` was already per agent and therefore per org, and
is untouched by any of this.

**A slice applies at `TENANCY_MODE=multi` only.** No prune carries an `orgId`,
so confinement is the `org_isolation` policies' job, and at `single` there are
no policies at all. `forEachOrg` iterates every ACTIVE org in both modes and
the org API creates orgs in both, so a `single` install can hold more than one
— and one org's seven-day window would then delete every org's rows. A slice
set at `single` is stored and returned by the org API, and the sweep logs that
it is ignoring it; switching the install to `multi` turns it on.

**Writing it**: `PATCH /api/v1/admin/orgs/[id]` with
`{ "settings": { "retention": { … } } }` — platform admin only until the org
console (§111) gives an org admin a surface of their own. The PATCH **replaces**
the slice (a body states the org's whole set of windows) and preserves every
other key in `settings`, which is where a fork keeps its own org config.
`{ "retention": null }` removes the slice.

**Reading it**: the sweep resolves the effective windows inside the org's own
run (`loadEffectiveRetentionWindows()`), and logs which windows the org
overrode. `GET /api/v1/orgs/[id]` publishes the validated slice to any member;
`GET /api/v1/admin/orgs/[id]` returns the whole `settings` column.

**The prunes rely on the policies, and per-org windows raise the stakes of
running without them.** No prune carries an `orgId` in its `where` clause —
the extension is the chokepoint (§107), so confinement at `multi` is the
`org_isolation` policies' job. In the window the playbook warns about — an app
live at `multi` before `db:tenancy:enable` has run, or after a `db:reset` left
the policies dormant — every org already sees every org's rows. What changes
here is what the tick does in that window: with one global window its N runs
deleted the same set N times, and with per-org windows the shortest window any
org set is applied to everyone's rows. Enable the policies before the app
serves `multi`, which the
[playbook](../architecture/multi-tenancy.md) already requires for isolation of
any kind.

**A stored window that cannot be read is treated as absent**, and only that
window: the org inherits the global value for it, keeps the rest of its slice,
and the sweep logs which keys it dropped. Discarding the whole slice over one
bad key would silently shorten every window the org had lengthened, which is
the one direction that deletes data. A settings **read failure** is different
again — the sweep skips its prunes for that org entirely rather than falling
back to windows the org may have rejected.

## Terminal-only pruning (executions & evaluations)

Execution and evaluation prunes **never delete in-flight work**, regardless of age:

- **Executions** — only `completed`, `failed`, `cancelled` are pruned. `running`,
  `pending`, and `paused_for_approval` are always kept.
- **Evaluations** — only `completed` / `archived` sessions and
  `completed` / `failed` / `cancelled` runs are pruned. `draft` / `in_progress`
  sessions and `queued` / `running` runs are always kept.

Cascade behaviour is FK-enforced: deleting an execution removes its step
dispatches, running steps, lease events, and per-step cost logs (and the
inbound-trigger payload stored in `inputData`); the rerun-lineage self-relation
is `SetNull`, so a pruned parent never takes its reruns with it. Deleting an eval
session removes its logs; deleting a run removes its cases. Experiment-variant
links and rescore lineage are `SetNull`, so pruning never breaks a retained
experiment.

## Keep `costLogRetentionDays ≥ executionRetentionDays` (enforced)

`AiWorkflowExecution.totalCostUsd` is a scalar column on the execution row, so it
survives the `AiCostLog` rows behind it. Prune the logs first and an operator sees
an execution reporting real spend with an empty cost breakdown underneath — and no
way to tell a retention artefact from a bug in cost capture. Dashboard aggregates
are unaffected; it's the per-execution drill-down that empties.

Unlike the evaluation coupling below, this one is **enforced in code**, in four
places: the settings form blocks the save client-side, the Zod schema rejects a
whole-form save, the settings PATCH route re-checks the patch against the
persisted row (so moving either side alone is caught), and the org PATCH route
checks an org's slice against the **effective** pair — the half it sets plus the
half it inherits.

Two states still get past all four: an install configured before the checks
existed and never re-saved, and an org whose stored slice is made incoherent
later by a change to the global row it inherits the other half from. So
`enforceRetentionPolicies()` also logs a warning once per sweep, per org, naming
the org whose pair is wrong.

## Keep `evaluationRetentionDays ≤ executionRetentionDays`

Evaluation runs **reference the executions they tested** (e.g. workflow-as-judge,
workflow-as-subject) as a JSON link, **not a database FK**. Pruning an execution
can't break an eval row at the DB level, but a longer evaluation window than
execution window leaves those references dangling — the eval run survives while
the execution trace it points at is gone. Set the evaluation window at or below
the execution window. This is guidance, not a code constraint; the Settings-form
field help repeats it.

## MCP audit logs are always pruned

Unlike every other window, `McpServerConfig.auditRetentionDays` is **non-nullable
(default 90)**. There is no "keep forever" option — MCP audit rows older than the
configured window are deleted on every tick. A value `≤ 0` is treated as "skip"
defensively so a misconfigured zero can't wipe the whole audit trail.

## Adding a new prune

Each prune is a small, uniform addition to `lib/orchestration/retention.ts`:

1. Add a nullable `xRetentionDays` column to `AiOrchestrationSettings` (datamodel-diff
   migration — see [data-erasure.md](../privacy/data-erasure.md) for why DB-free
   diffing avoids the HNSW/tsvector index-drop trap).
2. Add a `pruneX()` function taking `maxAgeDays?: number | null` — `undefined`
   means "resolve it yourself" (via `resolveRetentionDays`, for direct callers),
   an explicit `null` means "skip". Then `deleteMany` by `createdAt < cutoff`,
   plus a terminal-status filter for any table with in-flight rows.
3. Add the column to `RetentionWindows` and `loadRetentionWindows()` in
   `lib/orchestration/retention-windows.ts`, call the prune from
   `enforceRetentionPolicies()` **passing the loaded window**, and add its count
   to `RetentionResult`. The sweep reads the settings row exactly once (#442); a
   prune that resolves its own window inside the sweep puts a round-trip back
   per tick. **If the table is a system model** (no `orgId` — `SYSTEM_MODELS` in
   `lib/tenancy/classification.ts`), call it from
   `enforceSystemRetentionPolicies()` instead and add the count to
   `SystemRetentionResult`: the tenant sweep runs once per org, and a system
   table pruned there is pruned N times.
4. **A tenant window is also an org-settable one.** Add the key to
   `ORG_RETENTION_KEYS` and `orgRetentionSchema` in
   `lib/validations/tenancy.ts`, with the same bound the global schema gives
   it — or, where the global schema gives it none, a bound of your own, as
   `webhookDlqRetentionDays` has. A test fails until you do — the two key lists are held level, because a
   window only the platform can set is one no org can override and nothing else
   would say so. A **system** window has no org slice and does not belong in
   either list.
5. Surface the setting: Zod schema (`lib/validations/orchestration.ts`), the
   settings PATCH route, the settings form (with `<FieldHelp>`), and the backup
   exporter/importer/schema for config round-trip.
6. Add a case to `tests/unit/lib/orchestration/retention.test.ts`, and one to
   `retention-windows.test.ts` if the resolution itself changed.

The maintenance tick needs no change — it already invokes both sweeps and logs
every count in its background-task summary.

## Related Documentation

- [Account Deletion & Right to Erasure](../privacy/data-erasure.md) — on-demand subject erasure (the other half of the data lifecycle)
- [Scheduling & Webhooks](./scheduling.md) — the maintenance tick and cron model
- [Costs & Budget](../admin/orchestration-costs.md) — cost-log retention in the costs UI
