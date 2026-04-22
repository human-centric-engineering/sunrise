# Audit Log

Immutable record of admin configuration changes across the orchestration surface (agents, workflows, capabilities, knowledge, settings, experiments, embed tokens, backups).

> Source of truth: `lib/orchestration/audit/admin-audit-logger.ts` + `app/admin/orchestration/audit-log/`. Update this doc when those files change.

## Quick reference

| Thing          | Path                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| Admin page     | `app/admin/orchestration/audit-log/page.tsx`                            |
| View component | `components/admin/orchestration/audit-log/audit-log-view.tsx`           |
| List API       | `app/api/v1/admin/orchestration/audit-log/route.ts`                     |
| Logger library | `lib/orchestration/audit/admin-audit-logger.ts`                         |
| Query schema   | `listAuditLogQuerySchema` in `lib/validations/orchestration.ts`         |
| Prisma model   | `AiAdminAuditLog` (`ai_admin_audit_log` table)                          |
| URL constant   | `API.ADMIN.ORCHESTRATION.AUDIT_LOG` in `lib/api/endpoints.ts`           |
| Sidebar entry  | `components/admin/admin-sidebar.tsx` → `/admin/orchestration/audit-log` |

Page URL: **`/admin/orchestration/audit-log`**.

## Page layout

Single client component (`AuditLogView`) — no server shell, no suspense island. Auth is enforced at the `/admin` layout boundary plus the API's `withAdminAuth`.

```
┌────────────────────────────────────────────────────────────────┐
│ Heading + Refresh button                                       │
├────────────────────────────────────────────────────────────────┤
│ [ Search input (client-side) ]  [ Entity type select ▼ ]       │
├────────────────────────────────────────────────────────────────┤
│ Table: Timestamp │ Action │ Entity │ User │ IP                 │
│   (row click → expands `changes` JSON inline below entity cell)│
├────────────────────────────────────────────────────────────────┤
│ Total count       · Pager (prev / "page / totalPages" / next)  │
└────────────────────────────────────────────────────────────────┘
```

### Filters

| Control        | Behaviour                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Search input   | **Client-side only** — filters the 25 rows currently loaded against `action`, `entityName`, and `user.name`. Does not round-trip to the API. |
| Entity type    | Server-side filter. Options: `agent`, `workflow`, `capability`, `knowledge_document`, `settings`, `webhook`. Selecting one resets to page 1. |
| Refresh button | Re-fetches the current page.                                                                                                                 |

Known gaps in the dropdown (present in the data, absent from the filter UI): `experiment`, `embed_token`, `backup`. The `webhook` option appears in the dropdown but **no call site currently emits `entityType: 'webhook'`** — it will always return zero results until webhook writes are wired up. To filter by any of these, hit the API directly with `?entityType=experiment` etc.

### Row detail

Clicking a row toggles an inline `<pre>` block (under the entity cell) containing `JSON.stringify(entry.changes, null, 2)`. If `changes` is null (create/delete events) nothing expands. `metadata` is fetched by the API but **not rendered** in the UI.

### Action badges

Variant is derived from the action suffix in `actionBadgeVariant()`:

| Suffix        | Badge variant | Example                           |
| ------------- | ------------- | --------------------------------- |
| `.create`     | `default`     | `agent.create`                    |
| `.update`     | `secondary`   | `workflow.update`                 |
| `.delete`     | `destructive` | `agent.delete`                    |
| anything else | `outline`     | `experiment.run`, `backup.export` |

## Data source

### `GET /api/v1/admin/orchestration/audit-log`

Admin-guarded (`withAdminAuth`) and rate-limited via `adminLimiter`. Returns a paginated envelope (`paginatedResponse`) ordered by `createdAt desc` with the author joined in.

**Query params** (validated by `listAuditLogQuerySchema`):

| Param        | Type      | Default | Notes                                                |
| ------------ | --------- | ------- | ---------------------------------------------------- |
| `page`       | int ≥1    | `1`     | From shared `paginationQuerySchema`.                 |
| `limit`      | int 1–100 | `10`    | View component hard-codes `25`.                      |
| `action`     | string    | —       | Exact match on `action` (e.g. `agent.update`).       |
| `entityType` | string    | —       | Exact match on `entityType`.                         |
| `entityId`   | string    | —       | Scope to a single entity (e.g. agent id).            |
| `userId`     | string    | —       | Scope to one admin.                                  |
| `dateFrom`   | date      | —       | `gte` on `createdAt`. Coerced via `z.coerce.date()`. |
| `dateTo`     | date      | —       | `lte` on `createdAt`.                                |

Response data rows include `user: { id, name, email }`. `changes` / `metadata` come through as `Json` (arbitrary-shape objects).

## Logger library

`lib/orchestration/audit/admin-audit-logger.ts` — fire-and-forget Prisma writer. Mirrors `lib/orchestration/mcp/audit-logger.ts`.

### Exports

| Name              | Signature                                                                          | Purpose                                               |
| ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `logAdminAction`  | `(entry: AdminAuditEntry) => void`                                                 | Queues an insert on `aiAdminAuditLog`. Never throws.  |
| `computeChanges`  | `(before, after: Record<string, unknown>) => Record<string, { from, to }> \| null` | Shallow JSON-stringify diff. Returns `null` if equal. |
| `AdminAuditEntry` | interface                                                                          | Input shape (see below).                              |

### `AdminAuditEntry` fields

```typescript
interface AdminAuditEntry {
  userId: string; // required — session.user.id
  action: string; // e.g. "agent.create", "settings.update"
  entityType: string; // "agent" | "workflow" | "capability" | ...
  entityId?: string | null;
  entityName?: string | null; // human-readable name at time of action
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  metadata?: Record<string, unknown> | null;
  clientIp?: string | null;
}
```

### Secret redaction

Fields whose name matches `/password|secret|token|key|credential/i` (case-insensitive) have their `from`/`to` values replaced with `"[REDACTED]"` before the insert. Applied to `changes` only — **not** to `metadata`, so never push raw secrets into `metadata`.

### Fire-and-forget semantics

`logAdminAction()` kicks off `prisma.aiAdminAuditLog.create(...)` with `void` — no `await`. Failures are swallowed and logged via `logger.error('Failed to write admin audit log', …)`. Callers must not depend on the insert having landed by the time they return a response. A dropped write is preferable to a failed admin action.

### Usage

```typescript
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

logAdminAction({
  userId: session.user.id,
  action: 'agent.update',
  entityType: 'agent',
  entityId: id,
  entityName: agent.name,
  changes: computeChanges(before as Record<string, unknown>, after as Record<string, unknown>),
  clientIp: getClientIP(request),
});
```

## What gets audited

Every `logAdminAction()` call site (as of grep at write time):

| Route                                         | Action                                                          | entityType           |
| --------------------------------------------- | --------------------------------------------------------------- | -------------------- |
| `agents/route.ts`                             | `agent.create`                                                  | `agent`              |
| `agents/[id]/route.ts`                        | `agent.update`, `agent.delete`                                  | `agent`              |
| `agents/[id]/embed-tokens/route.ts`           | `embed_token.create`                                            | `embed_token`        |
| `agents/[id]/embed-tokens/[tokenId]/route.ts` | `embed_token.update`, `embed_token.delete`                      | `embed_token`        |
| `workflows/route.ts`                          | `workflow.create`                                               | `workflow`           |
| `workflows/[id]/route.ts`                     | `workflow.update`, `workflow.delete`                            | `workflow`           |
| `capabilities/route.ts`                       | `capability.create`                                             | `capability`         |
| `knowledge/documents/route.ts`                | `knowledge_document.create` (×2 — file upload and text paste)   | `knowledge_document` |
| `knowledge/documents/bulk/route.ts`           | `knowledge_document.bulk_create` (only when `successCount > 0`) | `knowledge_document` |
| `knowledge/documents/fetch-url/route.ts`      | `knowledge_document.create`                                     | `knowledge_document` |
| `knowledge/documents/[id]/route.ts`           | `knowledge_document.delete`                                     | `knowledge_document` |
| `settings/route.ts`                           | `settings.update`                                               | `settings`           |
| `experiments/route.ts`                        | `experiment.create`                                             | `experiment`         |
| `experiments/[id]/route.ts`                   | `experiment.update`, `experiment.delete`                        | `experiment`         |
| `experiments/[id]/run/route.ts`               | `experiment.run`                                                | `experiment`         |
| `backup/export/route.ts`                      | `backup.export`                                                 | `backup`             |
| `backup/import/route.ts`                      | `backup.import`                                                 | `backup`             |

### Unsupported / absent

- **Capability update, delete** — no audit writes in `capabilities/[id]/route.ts` today; only `capability.create` lands. If you edit a capability the audit log will not show it.
- **Provider config changes** — provider CRUD endpoints do not call `logAdminAction`.
- **Webhook CRUD** — the UI exposes `webhook` as a filter value but no route emits `entityType: 'webhook'`. Filter will return zero rows.
- **API-key lifecycle** (`AiApiKey`, `McpApiKey`) — not audited via this logger.
- **Bulk agent actions** (`agents/bulk/route.ts`) — the route takes an `action: 'activate' | 'deactivate' | 'delete'` body but does not write per-agent audit entries.

If you add audit coverage for any of the above, extend the UI filter dropdown in `audit-log-view.tsx` (`ENTITY_TYPES`) to match.

## Retention

**None.** The `AiAdminAuditLog` model has no retention column (compare: `AiOrchestrationSettings.webhookRetentionDays` / `costLogRetentionDays`) and no cron job prunes it. The schema comment explicitly calls it "Immutable audit trail" — rows accumulate indefinitely. If volume becomes a problem, add a retention setting + cleanup job; today there's nothing to configure.

Indexed on `userId`, `action`, `(entityType, entityId)`, and `createdAt`, so the table scales for queries but not for storage.

## Related docs

- [Observability Dashboard](./orchestration-observability.md) — runtime traces (executions, conversations) — complements the configuration-change trail here.
- [Admin API reference](../orchestration/admin-api.md) — full admin HTTP surface.
- [Orchestration Endpoints](../api/orchestration-endpoints.md) — endpoint-level reference.
- [Settings page](./orchestration-costs.md) — retention settings live here (for webhook/cost logs, not audit log).
