/**
 * Shared helpers for workflow execution routes.
 *
 * Extracts the common pre-flight validation logic used by both:
 * - POST /api/v1/admin/orchestration/workflows/:id/execute
 * - GET  /api/v1/admin/orchestration/workflows/:id/execute-stream
 *
 * Validates the workflow ID, looks up the workflow, checks `isActive`,
 * parses the definition, and runs structural + semantic validation.
 */

import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateWorkflow, semanticValidateWorkflow } from '@/lib/orchestration/workflows';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { WorkflowDefinition } from '@/types/orchestration';

interface PrepareResult {
  workflow: { id: string };
  version: { id: string; version: number };
  definition: WorkflowDefinition;
}

/**
 * Options for `prepareWorkflowExecution`.
 *
 * `pinnedVersionId` overrides the "current published version" lookup. The
 * resume-from-paused-execution path uses this so a paused run sees the same
 * snapshot it started against, even if a new version has been published in
 * the meantime — that's the whole point of the publish/draft model.
 */
export interface PrepareWorkflowExecutionOptions {
  pinnedVersionId?: string | null;
}

/**
 * Validate and load a workflow for execution.
 *
 * 1. Parse `rawId` as a CUID
 * 2. Look up the workflow + its published version from the database
 * 3. Assert `isActive` and that a published version (or pinned version) exists
 * 4. Parse `version.snapshot` with `workflowDefinitionSchema`
 * 5. Run structural (`validateWorkflow`) and semantic validation
 *
 * The returned `version` is stamped onto `AiWorkflowExecution.versionId`
 * by the calling route so each execution is pinned to the snapshot it ran.
 * For resumes (`opts.pinnedVersionId` set), the snapshot is loaded from that
 * specific version row instead of the workflow's current published version.
 *
 * @throws {ValidationError} if the ID format, active check, no-published-version, or definition validation fails
 * @throws {NotFoundError} if the workflow does not exist, or the pinned version is missing / belongs to a different workflow
 */
export async function prepareWorkflowExecution(
  rawId: string,
  opts: PrepareWorkflowExecutionOptions = {}
): Promise<PrepareResult> {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id },
    include: { publishedVersion: true },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  if (!workflow.isActive) {
    throw new ValidationError(`Workflow ${id} is not active`, {
      isActive: ['Workflow must be active before it can be executed'],
    });
  }

  // Resolve which version to run against: either the explicit pinned id
  // (resume case) or the workflow's currently-published version (default).
  let resolvedVersion: { id: string; version: number; snapshot: unknown } | null;
  if (opts.pinnedVersionId) {
    const pinned = await prisma.aiWorkflowVersion.findUnique({
      where: { id: opts.pinnedVersionId },
      select: { id: true, version: true, snapshot: true, workflowId: true },
    });
    if (!pinned || pinned.workflowId !== id) {
      // Cross-workflow pin or deleted version. Refuse rather than silently
      // falling back to current published — the caller asked for a specific
      // pinned version and we shouldn't surprise them by running a different one.
      throw new NotFoundError(`Workflow ${id} has no version with id ${opts.pinnedVersionId}`);
    }
    resolvedVersion = { id: pinned.id, version: pinned.version, snapshot: pinned.snapshot };
  } else {
    if (!workflow.publishedVersion) {
      throw new ValidationError(`Workflow ${id} has no published version`, {
        publishedVersionId: ['Publish a draft before executing the workflow'],
      });
    }
    resolvedVersion = {
      id: workflow.publishedVersion.id,
      version: workflow.publishedVersion.version,
      snapshot: workflow.publishedVersion.snapshot,
    };
  }

  const defParsed = workflowDefinitionSchema.safeParse(resolvedVersion.snapshot);
  if (!defParsed.success) {
    throw new ValidationError(`Workflow ${id} has a malformed definition`, {
      workflowDefinition: defParsed.error.issues.map((i) => i.message),
    });
  }
  const definition = defParsed.data;

  const dag = validateWorkflow(definition);
  if (!dag.ok) {
    throw new ValidationError(`Workflow ${id} has a structurally invalid definition`, {
      workflowDefinition: dag.errors,
    });
  }

  const semantic = await semanticValidateWorkflow(definition);
  if (!semantic.ok) {
    throw new ValidationError(`Workflow ${id} references invalid agents or capabilities`, {
      workflowDefinition: semantic.errors,
    });
  }

  return {
    workflow: { id: workflow.id },
    version: { id: resolvedVersion.id, version: resolvedVersion.version },
    definition,
  };
}
