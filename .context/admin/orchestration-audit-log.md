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
│ [ Search input (debounced, server-side) ] [ Entity type ▼ ]    │
├────────────────────────────────────────────────────────────────┤
│ Table: Timestamp │ Action │ Entity │ User │ IP                 │
│   (row click → expands `changes` JSON inline below entity cell)│
├────────────────────────────────────────────────────────────────┤
│ Total count       · Pager (prev / "page / totalPages" / next)  │
└────────────────────────────────────────────────────────────────┘
```

### Filters

| Control        | Behaviour                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search input   | **Server-side** — debounced (300 ms), sent as `?q=` and applied in Prisma as an `OR` across `action`, `entityName`, and `user.name` (case-insensitive `contains`). Typing resets the page to 1.                                       |
| Entity type    | Server-side filter. Options include `agent`, `workflow`, `capability`, `provider`, `mcp_api_key`, `knowledge_document`, `settings`, `experiment`, `embed_token`, `backup`, `webhook`, `conversation`. Selecting one resets to page 1. |
| Refresh button | Re-fetches the current page.                                                                                                                                                                                                          |

Entity types present in the data but absent from the filter dropdown: `webhook` (for `hook.secret.*` and webhook CRUD events) and `conversation` (for `conversation.bulk_clear`). All other entity types with actual audit data have corresponding dropdown entries. To filter by any missing type, hit the API directly with `?entityType=webhook` etc.

### Row detail

Clicking a row toggles an inline detail block (under the entity cell) showing `changes` and `metadata` as labelled JSON sections. If both are null (some create/delete events) nothing expands.

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

| Param        | Type      | Default | Notes                                                                                |
| ------------ | --------- | ------- | ------------------------------------------------------------------------------------ |
| `page`       | int ≥1    | `1`     | From shared `paginationQuerySchema`.                                                 |
| `limit`      | int 1–100 | `10`    | View component hard-codes `25`.                                                      |
| `action`     | string    | —       | Exact match on `action` (e.g. `agent.update`).                                       |
| `entityType` | string    | —       | Exact match on `entityType`.                                                         |
| `entityId`   | string    | —       | Scope to a single entity (e.g. agent id).                                            |
| `userId`     | string    | —       | Scope to one admin.                                                                  |
| `dateFrom`   | date      | —       | `gte` on `createdAt`. Coerced via `z.coerce.date()`.                                 |
| `dateTo`     | date      | —       | `lte` on `createdAt`.                                                                |
| `q`          | string    | —       | Case-insensitive `OR` across `action`, `entityName`, and `user.name`. Max 100 chars. |

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

Fields whose name matches `/password|secret|credential|(?:key|token)(?:s?$)/i` have their `from`/`to` values replaced with `"[REDACTED]"` before the insert. The pattern matches `password`, `secret`, and `credential` anywhere in the field name, but `key` and `token` only when they end the field name — so `apiKey` and `refreshToken` are redacted but `apiKeyCount` and `tokenizeInput` are not. Applied to both `changes` (field-level redaction) and `metadata` (recursive key-matching via `sanitizeMetadata()`). Safe to include metadata in audit entries without leaking secrets.

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

| Route                                               | Action                                                              | entityType           |
| --------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| `agents/route.ts`                                   | `agent.create`                                                      | `agent`              |
| `agents/[id]/route.ts`                              | `agent.update`, `agent.delete`                                      | `agent`              |
| `agents/[id]/clone/route.ts`                        | `agent.clone`                                                       | `agent`              |
| `agents/[id]/instructions-revert/route.ts`          | `agent.instructions_revert`                                         | `agent`              |
| `agents/[id]/versions/[versionId]/restore/route.ts` | `agent.version_restore`                                             | `agent`              |
| `agents/[id]/capabilities/route.ts`                 | `agent.capability_attach`                                           | `agent`              |
| `agents/[id]/capabilities/[capId]/route.ts`         | `agent.capability_update`, `agent.capability_detach`                | `agent`              |
| `agents/[id]/invite-tokens/route.ts`                | `agent.invite_token_create`                                         | `agent`              |
| `agents/[id]/invite-tokens/[tokenId]/route.ts`      | `agent.invite_token_revoke`                                         | `agent`              |
| `agents/[id]/embed-tokens/route.ts`                 | `embed_token.create`                                                | `embed_token`        |
| `agents/[id]/embed-tokens/[tokenId]/route.ts`       | `embed_token.update`, `embed_token.delete`                          | `embed_token`        |
| `agents/import/route.ts`                            | `agent.import`                                                      | `agent`              |
| `agents/bulk/route.ts`                              | `agent.bulk.activate`, `agent.bulk.deactivate`, `agent.bulk.delete` | `agent`              |
| `workflows/route.ts`                                | `workflow.create`                                                   | `workflow`           |
| `workflows/[id]/route.ts`                           | `workflow.update`, `workflow.delete`                                | `workflow`           |
| `capabilities/route.ts`                             | `capability.create`                                                 | `capability`         |
| `capabilities/[id]/route.ts`                        | `capability.update`, `capability.delete`                            | `capability`         |
| `providers/route.ts`                                | `provider.create`                                                   | `provider`           |
| `providers/[id]/route.ts`                           | `provider.update`, `provider.delete`                                | `provider`           |
| `mcp/keys/route.ts`                                 | `mcp_api_key.create`                                                | `mcp_api_key`        |
| `mcp/keys/[id]/route.ts`                            | `mcp_api_key.update`, `mcp_api_key.delete`                          | `mcp_api_key`        |
| `mcp/keys/[id]/rotate/route.ts`                     | `mcp_api_key.rotate`                                                | `mcp_api_key`        |
| `knowledge/documents/route.ts`                      | `knowledge_document.create` (×2 — file upload and text paste)       | `knowledge_document` |
| `knowledge/documents/bulk/route.ts`                 | `knowledge_document.bulk_create` (only when `successCount > 0`)     | `knowledge_document` |
| `knowledge/documents/fetch-url/route.ts`            | `knowledge_document.create`                                         | `knowledge_document` |
| `knowledge/documents/[id]/route.ts`                 | `knowledge_document.delete`                                         | `knowledge_document` |
| `settings/route.ts`                                 | `settings.update`                                                   | `settings`           |
| `experiments/route.ts`                              | `experiment.create`                                                 | `experiment`         |
| `experiments/[id]/route.ts`                         | `experiment.update`, `experiment.delete`                            | `experiment`         |
| `experiments/[id]/run/route.ts`                     | `experiment.run`                                                    | `experiment`         |
| `backup/export/route.ts`                            | `backup.export`                                                     | `backup`             |
| `backup/import/route.ts`                            | `backup.import`                                                     | `backup`             |
| `hooks/route.ts`                                    | `webhook.create`                                                    | `webhook`            |
| `hooks/[id]/route.ts`                               | `webhook.update`, `webhook.delete`                                  | `webhook`            |
| `hooks/[id]/rotate-secret/route.ts`                 | `hook.secret.rotated`, `hook.secret.cleared`                        | `webhook`            |
| `webhooks/route.ts`                                 | `webhook_subscription.create`                                       | `webhook`            |
| `webhooks/[id]/route.ts`                            | `webhook_subscription.update`, `webhook_subscription.delete`        | `webhook`            |
| `conversations/clear/route.ts`                      | `conversation.bulk_clear`                                           | `conversation`       |

Note: bulk agent actions write a **single** audit entry per operation (not per-agent). The `metadata` field records affected agent IDs.

### Not yet audited

- **AiApiKey lifecycle** — no admin CRUD routes exist for this model; not audited via this logger.

## Retention

Controlled by `AiOrchestrationSettings.auditLogRetentionDays` (nullable integer, days). Pruned by `pruneAuditLogs()` in `lib/orchestration/retention.ts`, which runs as part of `enforceRetentionPolicies()` on each maintenance tick (`POST /api/v1/admin/orchestration/maintenance/tick`).

- `auditLogRetentionDays = null` → **no pruning** (default — rows accumulate indefinitely, preserving the original "immutable audit trail" behaviour).
- `auditLogRetentionDays = N` → rows with `createdAt < now - N days` are deleted. The count of pruned rows surfaces in the tick's `RetentionResult.auditLogsDeleted`.

The schema comment still calls this an "immutable audit trail" — pruning is a deliberate operator choice, not automatic. Keep `null` if compliance requires the full history.

Indexed on `userId`, `action`, `(entityType, entityId)`, and `createdAt`, so both queries and retention sweeps scale.

## Related docs

- [Observability Dashboard](./orchestration-observability.md) — runtime traces (executions, conversations) — complements the configuration-change trail here.
- [Admin API reference](../orchestration/admin-api.md) — full admin HTTP surface.
- [Orchestration Endpoints](../api/orchestration-endpoints.md) — endpoint-level reference.
- [Settings page](./orchestration-costs.md) — retention settings live here (webhook, cost log, and audit log).
