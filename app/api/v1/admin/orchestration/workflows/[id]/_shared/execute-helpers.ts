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
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { resolveMaxCostPerExecution } from '@/lib/orchestration/llm/cost-caps';
import type { WorkflowDefinition } from '@/types/orchestration';

interface PrepareResult {
  workflow: { id: string; maxCostPerExecutionUsd: number | null };
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

  // Pull operator-curated `AiProviderModel` rows into the in-memory model
  // registry before semantic validation runs. Without this, a step that
  // sets `modelOverride: 'gpt-5'` semantic-validates to UNKNOWN_MODEL_OVERRIDE
  // because the registry's hardcoded fallback only knows about a small
  // baseline set — even though the operator added gpt-5 via the admin Model
  // Matrix. The hydration is throttled per process (60 s TTL) so back-to-back
  // executions don't thrash the DB. Soft fail — a missing model still
  // surfaces as UNKNOWN_MODEL_OVERRIDE below, which is the right outcome.
  //
  // Lives in a separate server-only module rather than on the registry
  // itself because the registry is reachable from client components via
  // `lib/validations/orchestration.ts`; reaching for `prisma` from inside
  // it pulls `pg` into the browser bundle.
  await hydrateModelRegistryFromDb();

  const semantic = await semanticValidateWorkflow(definition);
  if (!semantic.ok) {
    throw new ValidationError(`Workflow ${id} references invalid agents or capabilities`, {
      workflowDefinition: semantic.errors,
    });
  }

  return {
    workflow: {
      id: workflow.id,
      maxCostPerExecutionUsd: workflow.maxCostPerExecutionUsd,
    },
    version: { id: resolvedVersion.id, version: resolvedVersion.version },
    definition,
  };
}

/**
 * Resolve the effective per-execution cost cap for a workflow run.
 *
 * Loads the `AiOrchestrationSettings` singleton once and combines with
 * the caller's explicit override (if any) and the workflow's own
 * default via the resolver in `lib/orchestration/llm/cost-caps.ts`.
 *
 * Returns `undefined` when no layer sets a value; the engine treats
 * that as "no per-execution cap" (only the agent's monthly budget
 * still applies). The resolved value is persisted onto
 * `AiWorkflowExecution.budgetLimitUsd` by the engine so resumes and
 * the lease-reaper path inherit it without re-resolving.
 */
export async function resolveEffectiveExecutionCap(args: {
  callerOverride: number | null | undefined;
  workflowDefault: number | null | undefined;
}): Promise<number | undefined> {
  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { defaultMaxCostPerExecutionUsd: true },
  });
  return resolveMaxCostPerExecution({
    callerOverride: args.callerOverride,
    workflowDefault: args.workflowDefault,
    settingsDefault: settings?.defaultMaxCostPerExecutionUsd ?? null,
  });
}
