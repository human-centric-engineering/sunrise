/**
 * Workflow version service — the only module that writes
 * `AiWorkflowVersion` rows or flips `AiWorkflow.publishedVersionId`.
 *
 * All mutating functions:
 *   1. Validate the snapshot they are about to write (Zod + structural DAG +
 *      semantic) — except `saveDraft`, which accepts an in-progress draft.
 *   2. Run inside a `$transaction` when more than one row is written.
 *   3. Emit a `logAdminAction` audit entry.
 *
 * See `.context/orchestration/workflow-versioning.md`.
 */

import { definitionRecipients, removeFromDefinition } from '@/lib/privacy/config-recipients';
import {
  lockSubjects,
  matchErasedSubjects,
  WRITER_TRANSACTION_OPTIONS,
  type ErasedSubjects,
} from '@/lib/privacy/erased-subjects';
import { Prisma } from '@prisma/client';
import type { PrismaClient, AiWorkflowVersion, AiWorkflow } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { NotFoundError, StaleRecordError, ValidationError } from '@/lib/api/errors';
import { assertCurrentVersion, recordVersion } from '@/lib/api/record-version';
import {
  assertUnchangedSince,
  lockedVersion,
  lockWorkflowRow,
  publishedSnapshotVersion,
  WORKFLOW_DEFINITION_VERSION_SELECT,
  workflowDefinitionVersion,
} from '@/lib/orchestration/config-versions';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';
import { semanticValidateWorkflow } from '@/lib/orchestration/workflows/semantic-validator';
import type { WorkflowDefinition } from '@/types/orchestration';

// Prisma re-export so callers don't have to import `Prisma` separately.
type Tx = Prisma.TransactionClient | PrismaClient;

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Run the full publish-time validation chain. Throws `ValidationError` with
 * field-keyed messages on the first failure, mirroring how the existing
 * route handlers report DAG / semantic errors.
 */
async function validatePublishableDefinition(
  definition: unknown,
  replacing: string | null
): Promise<WorkflowDefinition> {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new ValidationError('Workflow definition is malformed', {
      definition: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const dag = validateWorkflow(parsed.data);
  if (!dag.ok) {
    throw new ValidationError('Workflow definition is structurally invalid', {
      definition: dag.errors.map((e) => e.message),
    });
  }
  // At multi, an override's provider must be one the org is approved for —
  // unless the version being replaced already used it (§120 t-743).
  const semantic = await semanticValidateWorkflow(parsed.data, {
    approval: { held: () => publishedDefinition(replacing) },
  });
  if (!semantic.ok) {
    throw new ValidationError(
      'Workflow definition references invalid models, providers, agents or capabilities',
      {
        definition: semantic.errors.map((e) => e.message),
      }
    );
  }
  return parsed.data;
}

/** The definition a published version holds, or `null` when there is none. */
async function publishedDefinition(versionId: string | null): Promise<WorkflowDefinition | null> {
  if (!versionId) return null;
  const version = await prisma.aiWorkflowVersion.findUnique({
    where: { id: versionId },
    select: { snapshot: true },
  });
  const parsed = workflowDefinitionSchema.safeParse(version?.snapshot);
  return parsed.success ? parsed.data : null;
}

async function nextVersionNumber(client: Tx, workflowId: string): Promise<number> {
  const row = await client.aiWorkflowVersion.findFirst({
    where: { workflowId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return (row?.version ?? 0) + 1;
}

interface ResolvedWorkflow {
  id: string;
  name: string;
  publishedVersionId: string | null;
}

async function loadWorkflow(client: Tx, workflowId: string): Promise<ResolvedWorkflow> {
  const wf = await client.aiWorkflow.findUnique({
    where: { id: workflowId },
    select: { id: true, name: true, publishedVersionId: true },
  });
  if (!wf) throw new NotFoundError(`Workflow ${workflowId} not found`);
  return wf;
}

async function getVersionInt(client: Tx, versionId: string | null): Promise<number | null> {
  if (!versionId) return null;
  const row = await client.aiWorkflowVersion.findUnique({
    where: { id: versionId },
    select: { version: true },
  });
  return row?.version ?? null;
}

/**
 * The definition a writer may write, inside its transaction (§122 t-900).
 *
 * - **Erasure's locks are taken first** for every address and approver id it
 *   names. A publish, rollback or create inserts a new version row, which an
 *   erasure already scanning the versions would not see; with the locks,
 *   either the erasure commits before this reads, or it waits and scans after
 *   this commits. A save takes them too, before its version check.
 * - **An erased approver id is stripped**, the rest written. An id is never
 *   issued again, so nobody can re-add one on purpose, and the builder cannot
 *   show an account that is gone.
 * - **An erased address is written.** A copy loaded before the erasure is
 *   refused by its version instead (`assertUnchangedSince`), so an address in
 *   what reaches here was typed into a builder loaded after it: a deliberate
 *   re-add. Until t-900 every address anyone was ever erased under was
 *   refused, which kept such a re-add out for good.
 *
 * Returns the definition to write: the same object when nothing was stripped.
 */
async function lockedWithoutErasedApprovers(
  tx: Prisma.TransactionClient,
  definition: WorkflowDefinition
): Promise<WorkflowDefinition> {
  const named = definitionRecipients(definition as unknown as Prisma.JsonValue);
  await lockSubjects(tx, named);
  const erased = await matchErasedSubjects(tx, { userIds: named.userIds });
  return erased.userIds.length > 0
    ? withoutErasedRecipients(definition, { addresses: [], userIds: erased.userIds })
    : definition;
}

/**
 * The stored workflow a definition was copied from, and the version it was
 * copied at (§122 t-900): `publishedSnapshotVersion` for a copy of the
 * published snapshot (a custom template applied in the builder, a workflow
 * saved as a template), `workflowDefinitionVersion` for a copy of what the
 * builder shows (Duplicate). Either is accepted while it is current.
 */
export interface CopySource {
  workflowId: string;
  definitionVersion: string;
}

/** What a 412 says when the source of a copy has moved on. */
export const COPY_SOURCE_MOVED_MESSAGE =
  'The workflow or template this was copied from changed since you opened it. Reload, then copy it again.';

/**
 * Refuse a copy whose source has moved on since it was copied, under the
 * source's row lock. A copy is not new intent: whoever is erased in the
 * source now, but named in the copy, was named by the stored data, not typed
 * by the admin. Call after {@link lockedWithoutErasedApprovers} has taken
 * erasure's locks for everyone the copy names, so an erasure scrubbing the
 * source has either finished (the version moved) or waits for this commit.
 * A source this org cannot see, or that is gone, is refused the same way.
 */
async function assertCopySourceUnchanged(
  tx: Prisma.TransactionClient,
  source: CopySource
): Promise<void> {
  await lockWorkflowRow(tx, source.workflowId);
  const row = await tx.aiWorkflow.findUnique({
    where: { id: source.workflowId },
    select: WORKFLOW_DEFINITION_VERSION_SELECT,
  });
  const current = row && [workflowDefinitionVersion(row), publishedSnapshotVersion(row)];
  if (!current?.includes(source.definitionVersion)) {
    throw new StaleRecordError(COPY_SOURCE_MOVED_MESSAGE);
  }
}

/**
 * The definition without any erased person in it — the same object when none
 * were — removed exactly as erasure removes them (`removeFromDefinition`).
 * For approver ids (above), and for a backup bundle's people erased since it
 * was taken (t-805, t-902).
 */
export function withoutErasedRecipients(
  definition: WorkflowDefinition,
  erased: ErasedSubjects
): WorkflowDefinition {
  let current: Prisma.JsonValue = definition as unknown as Prisma.JsonValue;
  let changed = false;
  const subjects = [
    ...erased.addresses.map((address) => ({ userId: null, address })),
    ...erased.userIds.map((userId) => ({ userId, address: null })),
  ];
  for (const subject of subjects) {
    const change = removeFromDefinition(current, subject);
    if (!change) continue;
    current = change.definition;
    changed = true;
  }
  if (!changed) return definition;
  // Re-validated rather than cast back: the rewrite keeps the shape, and the
  // schema is what says so.
  return workflowDefinitionSchema.parse(current);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * The definition versions a builder's write was loaded at (`If-Match`, §122
 * t-900): `workflowDefinitionVersion` of the workflow as the builder read it.
 */
export type LoadedAt = readonly string[];

export interface SaveDraftArgs {
  workflowId: string;
  definition: WorkflowDefinition;
  loadedAt: LoadedAt;
  /**
   * Other fields the same request writes (name, slug, cost cap…), written in
   * the same update, after the version check: a refused save writes none of
   * them, and a slug conflict writes no draft.
   */
  alongside?: Prisma.AiWorkflowUpdateInput;
  userId: string;
  clientIp?: string | null;
}

/**
 * Write `draftDefinition` on a workflow. The caller has already Zod-validated
 * the body; this function intentionally does NOT run structural / semantic
 * validation so admins can save a half-built workflow and come back to it.
 *
 * Refused with 412 when the workflow's definition has moved on since the
 * builder loaded it (`loadedAt`): another admin saved, published or rolled
 * back, or an erasure scrubbed a person out of it.
 */
export async function saveDraft(
  args: SaveDraftArgs
): Promise<AiWorkflow & { definitionVersion: string }> {
  const { workflowId, definition, loadedAt, alongside, userId, clientIp } = args;
  await loadWorkflow(prisma, workflowId);

  // A builder tab opened before a person was erased saves the whole draft it
  // loaded, their address included: refused by its version, under the lock
  // erasure takes on the row (§122 t-900).
  const updated = await prisma.$transaction(async (tx) => {
    const toWrite = await lockedWithoutErasedApprovers(tx, definition);
    const record = { kind: 'workflow-definition' as const, id: workflowId };
    await assertUnchangedSince(tx, record, loadedAt);
    const written = await tx.aiWorkflow.update({
      where: { id: workflowId },
      data: { ...alongside, draftDefinition: toWrite as unknown as Prisma.InputJsonValue },
    });
    // The version this write left, under the same lock: the builder's next
    // save is checked against it.
    return { ...written, definitionVersion: await lockedVersion(tx, record) };
  }, WRITER_TRANSACTION_OPTIONS);

  logAdminAction({
    userId,
    action: 'workflow.draft.save',
    entityType: 'workflow',
    entityId: workflowId,
    // As written: a save can rename the workflow alongside the draft.
    entityName: updated.name,
    metadata: { hasDraft: true },
    clientIp: clientIp ?? null,
  });

  return updated;
}

export interface DiscardDraftArgs {
  workflowId: string;
  loadedAt: LoadedAt;
  /** As {@link SaveDraftArgs.alongside}. */
  alongside?: Prisma.AiWorkflowUpdateInput;
  userId: string;
  clientIp?: string | null;
}

/**
 * Clear the in-progress draft. No-op (still emits audit) if no draft exists.
 *
 * Refused with 412 when the definition has moved on since the builder loaded
 * it: the draft it would discard is not the one the admin saw.
 */
export async function discardDraft(
  args: DiscardDraftArgs
): Promise<AiWorkflow & { definitionVersion: string }> {
  const { workflowId, loadedAt, alongside, userId, clientIp } = args;
  await loadWorkflow(prisma, workflowId);

  const updated = await prisma.$transaction(async (tx) => {
    const record = { kind: 'workflow-definition' as const, id: workflowId };
    await assertUnchangedSince(tx, record, loadedAt);
    const written = await tx.aiWorkflow.update({
      where: { id: workflowId },
      data: { ...alongside, draftDefinition: Prisma.DbNull },
    });
    return { ...written, definitionVersion: await lockedVersion(tx, record) };
  }, WRITER_TRANSACTION_OPTIONS);

  logAdminAction({
    userId,
    action: 'workflow.draft.discard',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: updated.name,
    clientIp: clientIp ?? null,
  });

  return updated;
}

export interface PublishDraftArgs {
  workflowId: string;
  loadedAt: LoadedAt;
  userId: string;
  changeSummary?: string;
  clientIp?: string | null;
}

export interface PublishDraftResult {
  workflow: AiWorkflow;
  version: AiWorkflowVersion;
  /** The definition version the publish left, read under its lock (§122 t-900). */
  definitionVersion: string;
}

/**
 * Promote `draftDefinition` to a new immutable `AiWorkflowVersion` and pin
 * `publishedVersionId` to the new row. Atomic: validation runs first, then
 * insert + update + clear draft happen inside one transaction.
 *
 * Throws `ValidationError` if there is no draft, or if the draft fails
 * Zod / structural / semantic validation. Refused with 412 when the definition
 * has moved on since the builder loaded it (`loadedAt`): the draft stored now
 * is not the one the admin is publishing.
 */
export async function publishDraft(args: PublishDraftArgs): Promise<PublishDraftResult> {
  const { workflowId, loadedAt, userId, changeSummary, clientIp } = args;

  const existing = await prisma.aiWorkflow.findUnique({
    where: { id: workflowId },
    select: { id: true, name: true, ...WORKFLOW_DEFINITION_VERSION_SELECT },
  });
  if (!existing) throw new NotFoundError(`Workflow ${workflowId} not found`);
  // Checked here, before validation, so a stale builder is told to reload
  // rather than shown errors in a draft it has not seen; and again under the
  // lock below, against this read, so what was validated is what is published.
  const readAt = workflowDefinitionVersion(existing);
  assertCurrentVersion(loadedAt, readAt);
  if (existing.draftDefinition === null || existing.draftDefinition === undefined) {
    throw new ValidationError('No draft to publish', {
      draftDefinition: ['Workflow has no draft to publish'],
    });
  }

  const definition = await validatePublishableDefinition(
    existing.draftDefinition,
    existing.publishedVersionId
  );
  const previousVersionInt = await getVersionInt(prisma, existing.publishedVersionId);

  const result = await prisma.$transaction(async (tx) => {
    // The draft was read above, outside any lock: one read before a person was
    // erased must not become a published version naming them (t-805). An
    // erasure since that read changed the version, and is refused here.
    const toWrite = await lockedWithoutErasedApprovers(tx, definition);
    await assertUnchangedSince(tx, { kind: 'workflow-definition', id: workflowId }, [readAt]);
    const next = await nextVersionNumber(tx, workflowId);
    const version = await tx.aiWorkflowVersion.create({
      data: {
        workflowId,
        version: next,
        snapshot: toWrite as unknown as Prisma.InputJsonValue,
        changeSummary: changeSummary ?? null,
        createdBy: userId,
      },
    });
    const workflow = await tx.aiWorkflow.update({
      where: { id: workflowId },
      data: {
        publishedVersionId: version.id,
        draftDefinition: Prisma.DbNull,
      },
    });
    const definitionVersion = await lockedVersion(tx, {
      kind: 'workflow-definition',
      id: workflowId,
    });
    return { workflow, version, definitionVersion };
  }, WRITER_TRANSACTION_OPTIONS);

  logAdminAction({
    userId,
    action: 'workflow.publish',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: existing.name,
    changes: {
      publishedVersion: { from: previousVersionInt, to: result.version.version },
    },
    metadata: changeSummary ? { changeSummary } : null,
    clientIp: clientIp ?? null,
  });

  return result;
}

export interface RollbackArgs {
  workflowId: string;
  targetVersionId: string;
  userId: string;
  changeSummary?: string;
  clientIp?: string | null;
}

export interface RollbackResult {
  workflow: AiWorkflow;
  version: AiWorkflowVersion;
}

/**
 * Roll back to a prior version by creating a NEW version whose snapshot is a
 * copy of the target. Keeps the audit chain monotonic: history is never
 * rewritten. The target snapshot is re-validated before writing in case agent
 * or capability deletion has invalidated it since publication.
 *
 * **No `If-Match`** (§122 t-900). A rollback writes no copy the browser
 * holds: it copies a snapshot from the database, which erasure scrubs in
 * place. What could go stale is this function's own read of it, taken before
 * the transaction. So the transaction takes erasure's locks for everyone that
 * read names, then reads the snapshot again: an erasure either finished
 * before, and the second read differs, or waits until this commits and then
 * scrubs the new version too. A second read that differs is refused with 412
 * rather than written unvalidated; trying again reads the scrubbed snapshot.
 * The panel needs no version of its own for this: rolling back to a version
 * is intent, whatever the builder has open.
 */
export async function rollback(args: RollbackArgs): Promise<RollbackResult> {
  const { workflowId, targetVersionId, userId, changeSummary, clientIp } = args;

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id: workflowId },
    select: { id: true, name: true, publishedVersionId: true },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${workflowId} not found`);

  const target = await prisma.aiWorkflowVersion.findUnique({
    where: { id: targetVersionId },
  });
  if (!target) {
    throw new NotFoundError(`Workflow version ${targetVersionId} not found`);
  }
  if (target.workflowId !== workflowId) {
    throw new ValidationError('Version belongs to a different workflow', {
      targetVersionId: ['Version does not belong to the requested workflow'],
    });
  }

  const definition = await validatePublishableDefinition(
    target.snapshot,
    workflow.publishedVersionId
  );
  const previousVersionInt = await getVersionInt(prisma, workflow.publishedVersionId);

  let erasedRecipientsRemoved = false;
  const result = await prisma.$transaction(async (tx) => {
    // The target snapshot was read before the transaction: read it again
    // under erasure's locks (see the docblock). An erased approver id, which
    // a snapshot from before t-791 can still hold, is left out of the copy,
    // and the audit row says so.
    const copied = await lockedWithoutErasedApprovers(tx, definition);
    const current = await tx.aiWorkflowVersion.findUnique({
      where: { id: targetVersionId },
      select: { snapshot: true },
    });
    if (!current || recordVersion(current.snapshot) !== recordVersion(target.snapshot)) {
      throw new StaleRecordError(
        'That version changed a moment ago, as a person on it had their data erased. Try the rollback again.'
      );
    }
    erasedRecipientsRemoved = copied !== definition;
    const next = await nextVersionNumber(tx, workflowId);
    const version = await tx.aiWorkflowVersion.create({
      data: {
        workflowId,
        version: next,
        snapshot: copied as unknown as Prisma.InputJsonValue,
        changeSummary: changeSummary ?? `Rollback to v${target.version}`,
        createdBy: userId,
      },
    });
    const updated = await tx.aiWorkflow.update({
      where: { id: workflowId },
      data: { publishedVersionId: version.id },
    });
    return { workflow: updated, version };
  }, WRITER_TRANSACTION_OPTIONS);

  logAdminAction({
    userId,
    action: 'workflow.rollback',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: workflow.name,
    changes: {
      publishedVersion: { from: previousVersionInt, to: result.version.version },
    },
    metadata: {
      rolledBackToVersion: target.version,
      ...(erasedRecipientsRemoved ? { erasedRecipientsRemoved: true } : {}),
    },
    clientIp: clientIp ?? null,
  });

  return result;
}

export interface CreateInitialVersionArgs {
  tx: Tx;
  workflowId: string;
  definition: WorkflowDefinition;
  /** Where `definition` was copied from: a template, a duplicate, save-as-template. */
  copiedFrom?: CopySource;
  userId: string;
}

/**
 * Insert v1 for a freshly-created workflow and pin it. Always called from
 * inside the `prisma.$transaction` that creates the parent `AiWorkflow`
 * row, so the workflow + its initial version land atomically.
 */
export async function createInitialVersion(
  args: CreateInitialVersionArgs
): Promise<AiWorkflowVersion> {
  const { tx, workflowId, definition, copiedFrom, userId } = args;
  // A create typed from scratch is new intent (§122): an address in it was
  // typed on purpose. A copy of a stored workflow is not, so it is checked
  // against its source (t-900). A backup import has already left out who it
  // must (t-902).
  const toWrite = await lockedWithoutErasedApprovers(tx, definition);
  if (copiedFrom) await assertCopySourceUnchanged(tx, copiedFrom);
  const version = await tx.aiWorkflowVersion.create({
    data: {
      workflowId,
      version: 1,
      snapshot: toWrite as unknown as Prisma.InputJsonValue,
      changeSummary: 'Initial version',
      createdBy: userId,
    },
  });
  await tx.aiWorkflow.update({
    where: { id: workflowId },
    data: { publishedVersionId: version.id },
  });
  return version;
}

export interface ListVersionsOptions {
  limit?: number;
  cursor?: string;
}

export interface ListVersionsResult {
  versions: AiWorkflowVersion[];
  nextCursor: string | null;
}

/**
 * Paginated read, descending by version number. `cursor` is the id of the
 * last version on the previous page (versions are immutable, so id-cursor
 * is stable).
 */
export async function listVersions(
  workflowId: string,
  opts: ListVersionsOptions = {}
): Promise<ListVersionsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const versions = await prisma.aiWorkflowVersion.findMany({
    where: { workflowId },
    orderBy: { version: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = versions.length > limit;
  const page = hasMore ? versions.slice(0, limit) : versions;
  return {
    versions: page,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Single-version read. Used by the diff / version-detail views.
 */
export async function getVersion(workflowId: string, version: number): Promise<AiWorkflowVersion> {
  const row = await prisma.aiWorkflowVersion.findUnique({
    where: { workflowId_version: { workflowId, version } },
  });
  if (!row) {
    throw new NotFoundError(`Workflow ${workflowId} has no version ${version}`);
  }
  return row;
}
