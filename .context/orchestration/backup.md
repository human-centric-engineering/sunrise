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
- Knowledge-tag grants reconnect by `KnowledgeTag.slug`; knowledge-document grants reconnect by `AiKnowledgeDocument.slug` (v3) or `fileHash` (v2 fallback). A reference missing in the target environment is **warn-skipped** (the grant is dropped, the rest of the agent imports) — the backup importer is deliberately lenient, unlike the agent bundle import which fails the whole import. See `.context/orchestration/knowledge.md` for the slug key.
- Webhooks: **created only** if no identical URL already exists; otherwise skipped with a warning
- Settings: **fully replaced** with backup values if present
- Webhook secrets: always skipped (secret fields are never exported); import adds a warning

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
