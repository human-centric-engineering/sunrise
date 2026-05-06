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

import { Prisma } from '@prisma/client';
import type { PrismaClient, AiWorkflowVersion, AiWorkflow } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
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
async function validatePublishableDefinition(definition: unknown): Promise<WorkflowDefinition> {
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
  const semantic = await semanticValidateWorkflow(parsed.data);
  if (!semantic.ok) {
    throw new ValidationError('Workflow definition references invalid agents or capabilities', {
      definition: semantic.errors.map((e) => e.message),
    });
  }
  return parsed.data;
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

// ─── Public API ────────────────────────────────────────────────────────────

export interface SaveDraftArgs {
  workflowId: string;
  definition: WorkflowDefinition;
  userId: string;
  clientIp?: string | null;
}

/**
 * Write `draftDefinition` on a workflow. The caller has already Zod-validated
 * the body; this function intentionally does NOT run structural / semantic
 * validation so admins can save a half-built workflow and come back to it.
 */
export async function saveDraft(args: SaveDraftArgs): Promise<AiWorkflow> {
  const { workflowId, definition, userId, clientIp } = args;
  const wf = await loadWorkflow(prisma, workflowId);

  const updated = await prisma.aiWorkflow.update({
    where: { id: workflowId },
    data: { draftDefinition: definition as unknown as Prisma.InputJsonValue },
  });

  logAdminAction({
    userId,
    action: 'workflow.draft.save',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: wf.name,
    metadata: { hasDraft: true },
    clientIp: clientIp ?? null,
  });

  return updated;
}

export interface DiscardDraftArgs {
  workflowId: string;
  userId: string;
  clientIp?: string | null;
}

/**
 * Clear the in-progress draft. No-op (still emits audit) if no draft exists.
 */
export async function discardDraft(args: DiscardDraftArgs): Promise<AiWorkflow> {
  const { workflowId, userId, clientIp } = args;
  const wf = await loadWorkflow(prisma, workflowId);

  const updated = await prisma.aiWorkflow.update({
    where: { id: workflowId },
    data: { draftDefinition: Prisma.DbNull },
  });

  logAdminAction({
    userId,
    action: 'workflow.draft.discard',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: wf.name,
    clientIp: clientIp ?? null,
  });

  return updated;
}

export interface PublishDraftArgs {
  workflowId: string;
  userId: string;
  changeSummary?: string;
  clientIp?: string | null;
}

export interface PublishDraftResult {
  workflow: AiWorkflow;
  version: AiWorkflowVersion;
}

/**
 * Promote `draftDefinition` to a new immutable `AiWorkflowVersion` and pin
 * `publishedVersionId` to the new row. Atomic: validation runs first, then
 * insert + update + clear draft happen inside one transaction.
 *
 * Throws `ValidationError` if there is no draft, or if the draft fails
 * Zod / structural / semantic validation.
 */
export async function publishDraft(args: PublishDraftArgs): Promise<PublishDraftResult> {
  const { workflowId, userId, changeSummary, clientIp } = args;

  const existing = await prisma.aiWorkflow.findUnique({
    where: { id: workflowId },
    select: {
      id: true,
      name: true,
      draftDefinition: true,
      publishedVersionId: true,
    },
  });
  if (!existing) throw new NotFoundError(`Workflow ${workflowId} not found`);
  if (existing.draftDefinition === null || existing.draftDefinition === undefined) {
    throw new ValidationError('No draft to publish', {
      draftDefinition: ['Workflow has no draft to publish'],
    });
  }

  const definition = await validatePublishableDefinition(existing.draftDefinition);
  const previousVersionInt = await getVersionInt(prisma, existing.publishedVersionId);

  const result = await prisma.$transaction(async (tx) => {
    const next = await nextVersionNumber(tx, workflowId);
    const version = await tx.aiWorkflowVersion.create({
      data: {
        workflowId,
        version: next,
        snapshot: definition as unknown as Prisma.InputJsonValue,
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
    return { workflow, version };
  });

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

  const definition = await validatePublishableDefinition(target.snapshot);
  const previousVersionInt = await getVersionInt(prisma, workflow.publishedVersionId);

  const result = await prisma.$transaction(async (tx) => {
    const next = await nextVersionNumber(tx, workflowId);
    const version = await tx.aiWorkflowVersion.create({
      data: {
        workflowId,
        version: next,
        snapshot: definition as unknown as Prisma.InputJsonValue,
        changeSummary: changeSummary ?? `Rollback to v${target.version}`,
        createdBy: userId,
      },
    });
    const updated = await tx.aiWorkflow.update({
      where: { id: workflowId },
      data: { publishedVersionId: version.id },
    });
    return { workflow: updated, version };
  });

  logAdminAction({
    userId,
    action: 'workflow.rollback',
    entityType: 'workflow',
    entityId: workflowId,
    entityName: workflow.name,
    changes: {
      publishedVersion: { from: previousVersionInt, to: result.version.version },
    },
    metadata: { rolledBackToVersion: target.version },
    clientIp: clientIp ?? null,
  });

  return result;
}

export interface CreateInitialVersionArgs {
  tx: Tx;
  workflowId: string;
  definition: WorkflowDefinition;
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
  const { tx, workflowId, definition, userId } = args;
  const version = await tx.aiWorkflowVersion.create({
    data: {
      workflowId,
      version: 1,
      snapshot: definition as unknown as Prisma.InputJsonValue,
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
