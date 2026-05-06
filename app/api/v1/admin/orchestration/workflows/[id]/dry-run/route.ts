/**
 * Admin Orchestration — Workflow dry-run
 *
 * POST /api/v1/admin/orchestration/workflows/:id/dry-run
 *
 * Validates a workflow without executing it:
 *   1. Structural validation (DAG checks)
 *   2. Semantic validation (model/provider/capability existence)
 *   3. Template variable extraction — checks if `inputData` covers
 *      all `{{input.key}}` references in step configs
 *
 * Returns `{ ok, errors, warnings, extractedVariables }`.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  validateWorkflow,
  semanticValidateWorkflow,
  extractTemplateVariables,
} from '@/lib/orchestration/workflows';
import { cuidSchema } from '@/lib/validations/common';
import {
  workflowDefinitionSchema,
  dryRunWorkflowBodySchema,
} from '@/lib/validations/orchestration';

export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, dryRunWorkflowBodySchema);

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id },
    include: { publishedVersion: true },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  // Pick the snapshot to dry-run against per the requested target.
  let rawDefinition: unknown;
  if (body.target === 'draft') {
    if (workflow.draftDefinition === null || workflow.draftDefinition === undefined) {
      throw new ValidationError(`Workflow ${id} has no draft to dry-run`, {
        draftDefinition: ['Workflow has no draft'],
      });
    }
    rawDefinition = workflow.draftDefinition;
  } else if (body.target === 'version') {
    const versionRow = await prisma.aiWorkflowVersion.findUnique({
      where: { id: body.versionId! },
    });
    if (!versionRow || versionRow.workflowId !== id) {
      throw new NotFoundError(`Workflow ${id} has no version ${body.versionId}`);
    }
    rawDefinition = versionRow.snapshot;
  } else {
    if (!workflow.publishedVersion) {
      throw new ValidationError(`Workflow ${id} has no published version`, {
        publishedVersionId: ['Publish a draft before dry-running'],
      });
    }
    rawDefinition = workflow.publishedVersion.snapshot;
  }

  const defParsed = workflowDefinitionSchema.safeParse(rawDefinition);
  if (!defParsed.success) {
    throw new ValidationError(`Workflow ${id} has a malformed definition`, {
      workflowDefinition: defParsed.error.issues.map((i) => i.message),
    });
  }
  const definition = defParsed.data;

  // Run structural + semantic validation
  const structural = validateWorkflow(definition);
  const semantic = await semanticValidateWorkflow(definition);
  const errors = [...structural.errors, ...semantic.errors];

  // Extract template variables and check against provided input
  const extractedVariables = extractTemplateVariables(definition);
  const providedKeys = new Set(Object.keys(body.inputData));

  const warnings: string[] = [];
  for (const variable of extractedVariables) {
    if (variable === '__whole__') continue; // bare {{input}} — any inputData satisfies this
    if (!providedKeys.has(variable)) {
      warnings.push(`Template variable "{{input.${variable}}}" is not provided in inputData`);
    }
  }

  log.info('Workflow dry-run completed', {
    workflowId: id,
    ok: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    variableCount: extractedVariables.length,
  });

  return successResponse({
    ok: errors.length === 0,
    errors,
    warnings,
    extractedVariables,
  });
});
