/**
 * Admin Orchestration — Workflow DAG validation
 *
 * POST /api/v1/admin/orchestration/workflows/:id/validate
 *
 * Loads the workflow's stored `workflowDefinition`, runs the pure-logic
 * `validateWorkflow` structural checks, and returns `{ ok, errors }`.
 *
 * This endpoint ships fully functional in Session 3.2 — the validator is
 * plain code on the JSON definition, no engine required. The same
 * `validateWorkflow` call is re-used by:
 *   - `POST /workflows/:id/execute` (pre-flight)
 *   - the Session 5.2 `OrchestrationEngine`
 *   - the Session 5.1b workflow editor UI
 *
 * Rate-limited for consistency with other mutating-shaped admin routes.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { validateWorkflow, semanticValidateWorkflow } from '@/lib/orchestration/workflows';
import { cuidSchema } from '@/lib/validations/common';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
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
  if (!workflow.publishedVersion) {
    throw new ValidationError(`Workflow ${id} has no published version`, {
      publishedVersionId: ['Publish a draft before validating'],
    });
  }

  const defParsed = workflowDefinitionSchema.safeParse(workflow.publishedVersion.snapshot);
  if (!defParsed.success) {
    throw new ValidationError(`Workflow ${id} has a malformed definition`, {
      workflowDefinition: defParsed.error.issues.map((i) => i.message),
    });
  }
  const definition = defParsed.data;
  const structural = validateWorkflow(definition);
  // A diagnostic of the published version, so every override is checked
  // against the org's approved providers (§120 t-743), with none excused. It
  // saves nothing, so an unreadable policy skips that check, logged, rather
  // than failing the whole report.
  const semantic = await semanticValidateWorkflow(definition, {
    approval: { onUnreadable: 'skip' },
  });

  const errors = [...structural.errors, ...semantic.errors];
  const result = { ok: errors.length === 0, errors };

  log.info('Workflow validated', {
    workflowId: id,
    ok: result.ok,
    structuralErrors: structural.errors.length,
    semanticErrors: semantic.errors.length,
  });

  return successResponse(result);
});
