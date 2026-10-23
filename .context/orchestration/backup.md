# Orchestration Backup & Restore

The backup/restore system exports all non-secret orchestration configuration to a versioned JSON file and re-imports it via upsert — enabling environment migration, disaster recovery, and configuration cloning.

## Architecture

```
lib/orchestration/backup/
├── schema.ts      — Zod schema (current export: schemaVersion 3; reads 1/2/3)
├── scope.ts       — resolveBackupScope(): which org, and whether the shared part moves
├── exporter.ts    — exportOrchestrationConfig(scope)
└── importer.ts    — importOrchestrationConfig(raw, userId, scope)

app/api/v1/admin/orchestration/backup/
├── export/route.ts  — POST /backup/export
└── import/route.ts  — POST /backup/import
```

UI: `components/admin/orchestration/settings/backup-panel.tsx`

## Org scoping and the shared part (§109 t-738)

A backup has two parts:

| Part           | What                                                | Rows are                  |
| -------------- | --------------------------------------------------- | ------------------------- |
| The org's own  | agents, workflows, webhook subscriptions            | tenant-owned, one org's   |
| The shared one | capabilities, knowledge tags, the `global` settings | one row serving every org |

Both routes take two query parameters, resolved by `resolveBackupScope()`:

- **`orgId`** — the org to back up or restore into. Defaults to the active
  org. The export and import run inside `runAsOrg(orgId)` whatever org the
  admin's session is in, so at `multi` the `org_isolation` policy reads and
  writes that org's rows only. An unbound admin API key enters no org, so at
  `multi` it **must** name one (400 otherwise). Naming an org other than the
  active one asks the authorization policy again, about that org (403 if it
  says no; 404 if the org does not exist; 409 for an import into a
  **suspended** org, which every other path treats as closed — its backup can
  still be exported). At `single` only the install org may be named.
- **`shared`** — `true` or `false`: whether the shared part moves. Owner
  ruling, 2026-10-08, extending t-751's install-org rule to the export:
  - It moves only when the **caller** is in the install org — the org its
    session entered, as t-751's guard reads it, not the org named in
    `?orgId=` — or is an **unbound admin API key**, which acts as the install
    org. Naming the install org as the target from a customer's org does not
    count: switch to the install org, as for any other shared setting.
  - A caller in a customer org that asks (`shared=true`) is **refused** (403,
    `details.reason: shared_settings_install_org_only`) and the refusal is
    logged, not silently skipped.
  - Left unset, it is **included at `single`** — one org, nothing to protect,
    so single-tenant backups are unchanged — and **left out at `multi`**.

Left out, the export carries the shared fields empty (`capabilities: []`,
`knowledgeTags: []`, `settings: null`), so the bundle stays `schemaVersion: 3`
and older importers read it. On import a bundle's shared part is skipped with a
warning naming what it held, and `ImportResult.sharedSkipped` is `true`.

So a customer org at `multi` can back up and restore its own agents and
workflows; before t-738 the whole import was refused outside the install org.
The import route no longer declares `writesSharedSettings`: it enforces the
rule itself, and is listed in `UNDECLARED_ROUTE_EXCEPTIONS`
(`scripts/ci/shared-settings-writes.ts`) with that reason.

**Two consequences of the split, both deliberate:**

- An agent's tag grants resolve against tags the import wrote **and** tags
  already present, since tags are shared rows every org reads. A grant whose
  tag is in neither is warn-skipped as before.
- `AiWorkflow.slug` is unique across every org. A workflow whose slug another
  org holds is created under the first free slug (`findFreeWorkflowSlug`,
  §107 t-728), with a warning naming the new slug, instead of failing the whole
  import on the index. The probe answers yes/no only; no other org's row is
  read. The new slug also avoids every slug the bundle carries and every one
  this import already created. The renamed row is marked with
  `metadata.importedFromSlug`, so importing the same bundle into the same org
  again finds it and updates it rather than adding another copy. The marker is
  looked up only when another org holds the slug, and the exporter strips it,
  so it never travels to another install where it would mean nothing. The free
  slugs are worked out before the import's transaction opens, so its probes
  never wait on a second database connection while the transaction holds one.
  If another org takes a planned slug in between, the import rolls back and
  the route answers 409 — run it again.

The settings page's Backup panel acts on the active org. Where the shared part
may move it shows an **Include shared settings** checkbox, ticked by default;
in a customer's org at `multi` it backs up and restores that org's own part.

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
  "exportSeal": "<this install's HMAC over exportedAt, the org and the contact addresses>",
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
POST /api/v1/admin/orchestration/backup/export?orgId={id}&shared={true|false}
Authorization: Admin
Rate limit: adminLimiter

Response 200:
  Content-Type: application/json
  Content-Disposition: attachment; filename="orchestration-backup-{orgId}-{timestamp}.json"
  Body: BackupPayload JSON
```

Audit log: `backup.export` action recorded with `entityId` = the target org, whether the shared part was included, and entity/capability/workflow counts.

## Import

```
POST /api/v1/admin/orchestration/backup/import?orgId={id}&shared={true|false}
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
- Agents, workflows: **upserted by slug** (create or update) in the target org; capabilities by slug too, when the shared part is written
- Each imported agent gets an `AiAgentVersion` for its restored config (row and grants), so its newest version equals what it runs: `v1` for a created agent; the next version for an updated one, unless the backup left it unchanged, which adds nothing (t-779)
- System workflows are the seed's, as platform agents are, and are **skipped with a warning**, never created or versioned over. They are recognised two ways, both before the definition is parsed: by slug, from `SYSTEM_WORKFLOW_SLUGS` in `lib/orchestration/workflows/template-catalogue.ts` (which works on a target where the row is absent or another org's), and by an existing row's `isSystem` flag (which covers a fork's own seeded system workflow wherever the importing org can see the row; at `multi` a row in another org is invisible, and the import takes a free slug instead, as for any cross-org collision — see above). The export leaves out the same two, so a bundle never carries a row the import would refuse. A bundle exported before t-729 can still carry `tpl-provider-model-audit`; importing it reports the skip. Without it, the import would have published the bundle's older definition and could have deactivated the workflow or changed its template status, both of which PATCH refuses
- The cost, stated plainly: an admin's own edits to a system workflow (a published definition, a renamed title) are **not in the backup**, and a restore to a fresh install brings back the seed's version. The seed does not re-apply its definition on every deploy (a unit re-runs only when its content hash changes), so on the live install those edits persist; it is only backup and restore that drops them. This is the same trade system agents make, taken for the same reason: a backup cannot tell an admin's deliberate edit from a stale definition in an old bundle
- Built-in workflow templates are code, not configuration (§116 t-727): a template row holding a built-in slug (`tpl-customer-support` and the rest) is a seed-era copy of one, so the export leaves it out and the import skips it with a warning, and a backup taken before the upgrade cannot bring it back. The same slug on an ordinary workflow (a retired row an install switched back on) is backed up and restored like any other
- Knowledge-tag grants reconnect by `KnowledgeTag.slug`; knowledge-document grants reconnect by `AiKnowledgeDocument.slug` (v3) or `fileHash` (v2 fallback). A reference missing in the target environment is **warn-skipped** (the grant is dropped, the rest of the agent imports) — the backup importer is deliberately lenient, unlike the agent bundle import which fails the whole import. See `.context/orchestration/knowledge.md` for the slug key.
- Webhooks: **created only** if no identical URL already exists; otherwise skipped with a warning
- Settings: **fully replaced** with backup values if present and the shared part is written
- Webhook secrets: always skipped (secret fields are never exported); import adds a warning
- People whose data was erased are stripped from what the import writes — workflow recipients and approvers, email subscriptions (skipped), the escalation list — each with a warning; the import goes ahead (t-805). For every address (the email subscriptions', the escalation list's and the workflow definitions'), a bundle **this install sealed** (`exportSeal`, over `exportedAt`, the exporting org, and those three lists of addresses) and imported into the same org counts only erasures since its `exportedAt` (§122 t-902, t-900): someone erased before it was taken and still named in it was re-added on purpose, and is kept, with a warning counting them. Any other bundle — unsealed (every one exported before t-902), sealed before t-900 (its seal covers no workflow addresses), another install's or org's, edited, or exported before the install secret was rotated — counts every erasure, and a seal that does not verify is reported in the warnings. A workflow approver's user id is stripped whenever it was erased. See [Data erasure → Backup import](../privacy/data-erasure.md#backup-import-taken-at-t-902)
- Agents naming a provider the org is not approved for (at `TENANCY_MODE=multi`): **imported, with a warning** naming the agent and the providers (§120 t-743). Not skipped: skipping would drop an agent other imported rows may reference, and the call-time gate refuses its calls until the org is granted the provider. `POST /agents/import` does the same. Workflows whose steps override to such a provider are imported with a warning naming the steps. The check runs once, before the import's transaction and inside the target org — so it asks about the org being restored into, not the admin's active org, and an unbound admin key's import is checked against the org it named; if the org's provider policy cannot be read, the import goes ahead with one general warning saying the check did not run.

### `ImportResult` shape

```typescript
interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  knowledgeTags: { created: number; updated: number };
  settingsUpdated: boolean;
  sharedSkipped: boolean; // the bundle carried a shared part that was not written
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
