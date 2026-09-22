# Data Retention & Pruning

How Sunrise automatically deletes aged operational data. Pruning is enforced by
two sweeps in `lib/orchestration/retention.ts`, each a task of the unified
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

Unlike the evaluation coupling below, this one is **enforced in code**, in three
places: the settings form blocks the save client-side, the Zod schema rejects a
whole-form save, and the PATCH route re-checks the patch against the persisted row
(so moving either side alone is caught). Installs already configured this way
predate the check and never re-save settings, so `enforceRetentionPolicies()` also
logs a warning once per sweep when it sees the pair.

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
3. Add the column to `RetentionWindows` and `loadRetentionWindows()`, call the
   prune from `enforceRetentionPolicies()` **passing the loaded window**, and add
   its count to `RetentionResult`. The sweep reads the settings row exactly once
   (#442); a prune that resolves its own window inside the sweep puts a
   round-trip back per tick. **If the table is a system model** (no `orgId` —
   `SYSTEM_MODELS` in `lib/tenancy/classification.ts`), call it from
   `enforceSystemRetentionPolicies()` instead and add the count to
   `SystemRetentionResult`: the tenant sweep runs once per org, and a system
   table pruned there is pruned N times.
4. Surface the setting: Zod schema (`lib/validations/orchestration.ts`), the
   settings PATCH route, the settings form (with `<FieldHelp>`), and the backup
   exporter/importer/schema for config round-trip.
5. Add a case to `tests/unit/lib/orchestration/retention.test.ts`.

The maintenance tick needs no change — it already invokes both sweeps and logs
every count in its background-task summary.

## Related Documentation

- [Account Deletion & Right to Erasure](../privacy/data-erasure.md) — on-demand subject erasure (the other half of the data lifecycle)
- [Scheduling & Webhooks](./scheduling.md) — the maintenance tick and cron model
- [Costs & Budget](../admin/orchestration-costs.md) — cost-log retention in the costs UI
