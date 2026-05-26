# Data Retention & Pruning

How Sunrise automatically deletes aged operational data. All pruning is enforced
by `enforceRetentionPolicies()` in `lib/orchestration/retention.ts`, run as one
task of the unified maintenance tick (`POST /api/v1/admin/orchestration/maintenance/tick`,
called ~every 60s by an external cron). This is the **scheduled-purge** half of
the platform's data lifecycle; on-demand subject erasure is separate — see
[Account Deletion & Right to Erasure](../privacy/data-erasure.md).

## What gets pruned

| Data                                                                                         | Window setting                       | Owner           | Notes                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | --------------- | ----------------------------------------------- |
| Conversations (+ messages, embeddings, cost logs, shares)                                    | `AiAgent.retentionDays`              | per-agent       | `null` = keep forever. Pruned by `updatedAt`.   |
| Webhook deliveries (non-DLQ)                                                                 | `webhookRetentionDays`               | global settings |                                                 |
| Webhook DLQ (`exhausted`)                                                                    | `webhookDlqRetentionDays`            | global settings | Falls back to `webhookRetentionDays` when null. |
| Event-hook deliveries                                                                        | `webhookRetentionDays`               | global settings | Same class as webhook deliveries.               |
| Cost logs                                                                                    | `costLogRetentionDays`               | global settings | Dashboard aggregates are unaffected.            |
| Admin audit logs                                                                             | `auditLogRetentionDays`              | global settings | Max 3650 days (10y) for compliance regimes.     |
| **Workflow executions** (+ steps, dispatches, lease events, per-step cost, inbound payloads) | `executionRetentionDays`             | global settings | **Terminal only** — see below.                  |
| **Evaluation history** (`AiEvaluationSession` / `Run` + their logs/cases)                    | `evaluationRetentionDays`            | global settings | **Terminal only** — see below.                  |
| MCP audit logs                                                                               | `McpServerConfig.auditRetentionDays` | MCP config      | **Always on** (default 90) — see below.         |

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
2. Add a `pruneX()` function (resolve the window via `resolveRetentionDays`, skip
   when null, `deleteMany` by `createdAt < cutoff` — and a terminal-status filter
   for any table with in-flight rows).
3. Call it in `enforceRetentionPolicies()` and add its count to `RetentionResult`.
4. Surface the setting: Zod schema (`lib/validations/orchestration.ts`), the
   settings PATCH route, the settings form (with `<FieldHelp>`), and the backup
   exporter/importer/schema for config round-trip.
5. Add a case to `tests/unit/lib/orchestration/retention.test.ts`.

The maintenance tick needs no change — it already invokes `enforceRetentionPolicies()`
and logs every count in its background-task summary.

## Related Documentation

- [Account Deletion & Right to Erasure](../privacy/data-erasure.md) — on-demand subject erasure (the other half of the data lifecycle)
- [Scheduling & Webhooks](./scheduling.md) — the maintenance tick and cron model
- [Costs & Budget](../admin/orchestration-costs.md) — cost-log retention in the costs UI
