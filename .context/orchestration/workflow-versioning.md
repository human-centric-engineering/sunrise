# Workflow versioning

Each workflow is a chain of immutable `AiWorkflowVersion` rows plus an
optional in-progress `draftDefinition`. Executions resolve their definition
via `publishedVersionId` and stamp the resolved version onto the execution
row, so a mid-edit draft never alters in-flight runs.

## Why this exists

Before this model the PATCH endpoint overwrote `workflowDefinition` directly
and pushed the prior value onto a 50-entry JSON history column. Mid-edit
saves immediately altered the definition that scheduled and webhook-triggered
executions read. Rollback was a destructive overwrite of the current
definition with a historical entry. There was no way to compare two arbitrary
versions, no audit-trail of who promoted what, and no concept of a draft.

The publish/draft/rollback model addresses three concrete needs:

- **Iteration safety.** Save mid-edit work without affecting executions.
- **Per-execution provenance.** Every `AiWorkflowExecution` row records the
  version it ran against — `executionTrace` debugging stays honest across
  edits.
- **Monotonic audit.** History rows are immutable; rollback creates a new
  version copied from the target rather than rewinding the pointer.

## Data model

### `AiWorkflowVersion` (immutable)

| Column          | Notes                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `id`            | CUID (or UUID for backfilled rows from the migration).                   |
| `workflowId`    | FK to `AiWorkflow`. Cascade delete.                                      |
| `version`       | Monotonic integer per workflow, starts at 1, unique within a workflow.   |
| `snapshot`      | Full `WorkflowDefinition` JSON at publish time. Never mutated.           |
| `changeSummary` | Optional admin-supplied label (≤ 500 chars). `null` for backfilled rows. |
| `createdBy`     | FK to `User`.                                                            |
| `createdAt`     | Insert timestamp.                                                        |

Mirrors `AiAgentVersion`. Version rows are insert-only; rollback creates a
new row whose `snapshot` is a copy of the target.

### `AiWorkflow` (changes)

- Adds `publishedVersionId` (FK, nullable) — the snapshot executions pin to.
  Null only for workflows that have never published, which today is impossible
  via any code path: POST `/workflows` and the migration backfill both seed v1.
- Adds `draftDefinition` (nullable JSON) — in-progress work. PATCH writes
  here; published versions are only updated via POST `/publish`.
- **Drops** `workflowDefinition` and `workflowDefinitionHistory` — replaced
  by the version chain. The grep guard in `/pre-pr` catches accidental
  re-introduction.

### `AiWorkflowExecution.versionId` (pinned)

Optional FK to `AiWorkflowVersion`. New executions always set it. Pre-migration
rows have it null and fall back to `workflow.publishedVersion.snapshot` if a
recovery path needs to resume them.

## Service layer

`lib/orchestration/workflows/version-service.ts` is the only module that
writes version rows or flips `publishedVersionId`. Routes call into it; nothing
else touches the underlying tables directly.

| Function               | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `saveDraft`            | Writes `draftDefinition`. **No** structural / semantic validation — drafts can be partial. |
| `discardDraft`         | Clears `draftDefinition`.                                                                  |
| `publishDraft`         | Promotes the draft. Runs Zod + `validateWorkflow` + `semanticValidateWorkflow` first.      |
| `rollback`             | Creates a NEW version copied from `targetVersionId` and pins it. Validates the snapshot.   |
| `createInitialVersion` | Helper used by POST `/workflows` and `save-as-template` inside their transactions.         |
| `listVersions`         | Paginated read, descending by `version` int.                                               |
| `getVersion`           | Single-version read by `version` int.                                                      |

Mutating functions:

- Validate snapshots **before** writing (publish/rollback only — `saveDraft`
  intentionally accepts partial work).
- Run inside a Prisma `$transaction` whenever multiple rows change.
- Emit a `logAdminAction` audit entry — see "Audit events" below.

## Execution model

`prepareWorkflowExecution(rawId)` (in
`app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers.ts`):

1. Parse the rawId as a CUID.
2. Look up the workflow with `include: { publishedVersion: true }`.
3. Reject if `publishedVersionId` is null (no version published yet).
4. Parse `version.snapshot` with `workflowDefinitionSchema`.
5. Run structural + semantic validation.
6. Return `{ workflow: { id }, definition, version: { id, version } }`. The
   caller stamps `versionId` onto the new `AiWorkflowExecution` row.

The engine (`OrchestrationEngine.execute`) accepts a `versionId` on its
`ExecuteWorkflowArg` and passes it straight through to the execution row
insert. Every entry point sets it:

- Manual run via POST `/workflows/:id/execute` and the SSE variant.
- Scheduled via `processDueSchedules` in the scheduler.
- Webhook trigger at `POST /api/v1/webhooks/trigger/:slug`.
- Programmatic `run_workflow` capability call from another agent.

For resume / recovery, `resumeApprovedExecution` and `processPendingExecutions`
prefer the pinned version on the execution row, falling back to the workflow's
current published version if the row pre-dates pinning.

## API surface

All routes live under `app/api/v1/admin/orchestration/workflows/[id]/`.

| Method  | Path                          | Notes                                                                       |
| ------- | ----------------------------- | --------------------------------------------------------------------------- |
| `PATCH` | `/`                           | Definition edits write to `draftDefinition`. Other field updates unchanged. |
| `POST`  | `/publish`                    | Body `{ changeSummary?: string }`. Returns the new version.                 |
| `POST`  | `/discard-draft`              | No body. Clears `draftDefinition`. Published version unaffected.            |
| `POST`  | `/rollback`                   | Body `{ targetVersionId, changeSummary? }`. Creates a NEW version.          |
| `GET`   | `/versions`                   | Paginated. Returns `{ versions, publishedVersionId, nextCursor }`.          |
| `GET`   | `/versions/:version`          | Single-version read by integer label.                                       |
| `POST`  | `/dry-run`                    | Optional `target: 'published' \| 'draft' \| 'version'`. Default published.  |
| `POST`  | `/execute`, `/execute-stream` | Stamp `versionId` on the new execution row.                                 |

POST `/workflows` (create) seeds v1 atomically inside a transaction. The
created workflow is immediately runnable — admins do not need to publish
before the first execute.

The legacy `/definition-history` and `/definition-revert` routes have been
removed.

## Audit events

Emitted by `version-service` via the existing `logAdminAction` helper.

| Action                   | Changes                              | Metadata                        |
| ------------------------ | ------------------------------------ | ------------------------------- |
| `workflow.draft.save`    | none                                 | `{ hasDraft: true }`            |
| `workflow.draft.discard` | none                                 | none                            |
| `workflow.publish`       | `{ publishedVersion: { from, to } }` | `{ changeSummary }` if provided |
| `workflow.rollback`      | `{ publishedVersion: { from, to } }` | `{ rolledBackToVersion }`       |

The legacy `workflow.definition_revert` action is removed.

## Backup & restore

`lib/orchestration/backup/` flattens the published snapshot back to the wire
shape the importer reads (`workflowDefinition` field on each workflow entry).
Importing seeds a new v1 via `createInitialVersion` for create paths, or
appends a vN+1 with `changeSummary: "Imported from backup"` when the slug
already exists. The backup payload is not point-in-time history — only the
currently published snapshot survives a round-trip.

## Anti-patterns

- **Don't** read `workflow.workflowDefinition` directly. The column is gone.
  Read `workflow.publishedVersion?.snapshot` for the executable definition or
  `workflow.draftDefinition` for the in-progress work.
- **Don't** mutate version rows. They are insert-only by contract; rollback
  creates a new version.
- **Don't** call `prisma.aiWorkflowVersion.create` outside `version-service`
  and the migration. Routes should always go through `publishDraft` /
  `rollback` / `createInitialVersion` so audit + validation stays consistent.
- **Don't** assume `publishedVersionId` is non-null without an explicit guard.
  POST `/workflows` always seeds v1, but legacy code paths or future schema
  changes might invalidate that — every read site that expects a published
  snapshot must handle the null case.

## Out of scope

- **Multiple concurrent drafts / branches.** Single-draft model is sufficient
  at this profile; multi-draft would need a junction table and is an additive
  future change.
- **Per-environment promotion** (dev → staging → prod). Each Sunrise project
  deploys itself; cross-environment promotion is a venture-studio process
  problem, not a runtime feature.

## Critical files

- `prisma/schema.prisma` — `AiWorkflow`, `AiWorkflowVersion`, `AiWorkflowExecution`.
- `prisma/migrations/20260506151928_add_workflow_versioning/migration.sql`
- `lib/orchestration/workflows/version-service.ts`
- `lib/orchestration/workflows/index.ts`
- `lib/validations/orchestration.ts` — `publishWorkflowSchema`, `rollbackWorkflowSchema`, `updateWorkflowSchema`.
- `app/api/v1/admin/orchestration/workflows/route.ts` — POST creates v1.
- `app/api/v1/admin/orchestration/workflows/[id]/route.ts` — PATCH writes to draft.
- `app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers.ts` — published-version resolution.
- `app/api/v1/admin/orchestration/workflows/[id]/{publish,discard-draft,rollback,versions}/`
- `lib/orchestration/engine/orchestration-engine.ts` — `versionId` threading.
- `lib/orchestration/scheduling/scheduler.ts` — pinned-version recovery.
- `lib/orchestration/capabilities/built-in/run-workflow.ts` — pinned-version dispatch.
- `lib/orchestration/backup/{exporter,importer}.ts`
- `components/admin/orchestration/workflow-builder/{workflow-builder,builder-toolbar,publish-dialog}.tsx`
- `components/admin/orchestration/workflow-definition-history-panel.tsx` — re-sourced from `/versions`.
