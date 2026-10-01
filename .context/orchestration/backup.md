# Orchestration Backup & Restore

The backup/restore system exports all non-secret orchestration configuration to a versioned JSON file and re-imports it via upsert — enabling environment migration, disaster recovery, and configuration cloning.

## Architecture

```
lib/orchestration/backup/
├── schema.ts      — Zod schema (current export: schemaVersion 3; reads 1/2/3)
├── exporter.ts    — exportOrchestrationConfig()
└── importer.ts    — importOrchestrationConfig()

app/api/v1/admin/orchestration/backup/
├── export/route.ts  — POST /backup/export
└── import/route.ts  — POST /backup/import
```

UI: `components/admin/orchestration/settings/backup-panel.tsx`

## Backup Payload (current `schemaVersion: 3`)

The importer accepts `schemaVersion` 1, 2, or 3. Version history:

- **v1** — original.
- **v2** — adds `AiAgent.knowledgeAccessMode`, `grantedTagSlugs`, a top-level
  `knowledgeTags` taxonomy, and document grants keyed by `grantedDocumentHashes`
  (`AiKnowledgeDocument.fileHash`).
- **v3** — document grants move to `grantedDocumentSlugs`
  (`AiKnowledgeDocument.slug`, the stable cross-environment key — #338),
  consistent with the agent bundle and with tags/profiles/capabilities. Exports
  no longer emit `grantedDocumentHashes`; the importer still **falls back** to
  hash lookup when a (v2) bundle carries no slugs.

```json
{
  "schemaVersion": 3,
  "exportedAt": "2026-04-22T10:00:00.000Z",
  "data": {
    "agents":       [...],
    "capabilities": [...],
    "workflows":    [...],
    "webhooks":     [...],
    "settings":     { ... } | null
  }
}
```

What is **excluded** from exports:

- System agents (`isSystem: true`)
- System capabilities (`isSystem: true`)
- System workflows (`isSystem: true`, or a slug in `SYSTEM_WORKFLOW_SLUGS`, e.g. `tpl-provider-model-audit`)
- Webhook `secret` fields (skipped with a warning on import)
- Message embeddings, conversations, user data
- Cost logs, execution history

## Export

```
POST /api/v1/admin/orchestration/backup/export
Authorization: Admin
Rate limit: adminLimiter

Response 200:
  Content-Type: application/json
  Content-Disposition: attachment; filename="orchestration-backup-{timestamp}.json"
  Body: BackupPayload JSON
```

Audit log: `backup.export` action recorded with entity/capability/workflow counts.

## Import

```
POST /api/v1/admin/orchestration/backup/import
Authorization: Admin
Rate limit: adminLimiter
Content-Type: application/json
Body: BackupPayload (validated against Zod schema)

Response 200:
  { "success": true, "data": ImportResult }
```

### Import behaviour

- Validates body against `backupSchema` (Zod) — 400 `VALIDATION_ERROR` on mismatch
- Runs in a **single Prisma transaction** — partial failure rolls back everything
- Agents, capabilities, workflows: **upserted by slug** (create or update)
- System workflows are the seed's, as platform agents are, and are **skipped with a warning**, never created or versioned over. They are recognised two ways, both before the definition is parsed: by slug, from `SYSTEM_WORKFLOW_SLUGS` in `lib/orchestration/workflows/template-catalogue.ts` (which works on a target where the row is absent or another org's), and by an existing row's `isSystem` flag (which covers a fork's own seeded system workflow wherever the importing org can see the row; at `multi` a row in another org is invisible, and the import fails on the slug as any cross-org slug collision does until t-738). The export leaves out the same two, so a bundle never carries a row the import would refuse. A bundle exported before t-729 can still carry `tpl-provider-model-audit`; importing it reports the skip. Without it, the import would have published the bundle's older definition and could have deactivated the workflow or changed its template status, both of which PATCH refuses
- The cost, stated plainly: an admin's own edits to a system workflow (a published definition, a renamed title) are **not in the backup**, and a restore to a fresh install brings back the seed's version. The seed does not re-apply its definition on every deploy (a unit re-runs only when its content hash changes), so on the live install those edits persist; it is only backup and restore that drops them. This is the same trade system agents make, taken for the same reason: a backup cannot tell an admin's deliberate edit from a stale definition in an old bundle
- Built-in workflow templates are code, not configuration (§116 t-727): a template row holding a built-in slug (`tpl-customer-support` and the rest) is a seed-era copy of one, so the export leaves it out and the import skips it with a warning, and a backup taken before the upgrade cannot bring it back. The same slug on an ordinary workflow (a retired row an install switched back on) is backed up and restored like any other
- Knowledge-tag grants reconnect by `KnowledgeTag.slug`; knowledge-document grants reconnect by `AiKnowledgeDocument.slug` (v3) or `fileHash` (v2 fallback). A reference missing in the target environment is **warn-skipped** (the grant is dropped, the rest of the agent imports) — the backup importer is deliberately lenient, unlike the agent bundle import which fails the whole import. See `.context/orchestration/knowledge.md` for the slug key.
- Webhooks: **created only** if no identical URL already exists; otherwise skipped with a warning
- Settings: **fully replaced** with backup values if present
- Webhook secrets: always skipped (secret fields are never exported); import adds a warning
- Agents naming a provider the org is not approved for (at `TENANCY_MODE=multi`): **imported, with a warning** naming the agent and the providers (§120 t-743). Not skipped: skipping would drop an agent other imported rows may reference, and the call-time gate refuses its calls until the org is granted the provider. `POST /agents/import` does the same.

### `ImportResult` shape

```typescript
interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  settingsUpdated: boolean;
  warnings: string[]; // e.g. "Webhook secret skipped — re-enter manually"
}
```

## UI — BackupPanel

Located in the Settings tab (`/admin/orchestration/settings`).

**Export section** — "Download Backup" button:

- POSTs to `/api/v1/admin/orchestration/backup/export`
- Creates a blob URL and auto-clicks a hidden `<a>` element to trigger browser download
- Filename from `Content-Disposition` header
- Error shown inline on non-2xx response

**Import section** — file drop zone:

- Accepts `.json` files via file picker or drag-and-drop
- Validates file as JSON client-side before sending
- POSTs parsed JSON to `/api/v1/admin/orchestration/backup/import`
- Shows `ImportResult` summary: entity counts, settings flag, warnings list
- Keyboard accessible: Enter/Space on drop zone triggers file picker

## Error handling

| Scenario                | HTTP | Error code            |
| ----------------------- | ---- | --------------------- |
| Unauthenticated         | 401  | `UNAUTHORIZED`        |
| Non-admin               | 403  | `FORBIDDEN`           |
| Rate limited            | 429  | `RATE_LIMIT_EXCEEDED` |
| Invalid JSON body       | 400  | `VALIDATION_ERROR`    |
| Schema version mismatch | 400  | `VALIDATION_ERROR`    |
| Export failure          | 500  | `INTERNAL_ERROR`      |
