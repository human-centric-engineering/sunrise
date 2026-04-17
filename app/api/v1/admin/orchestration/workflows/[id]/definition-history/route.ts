/**
 * Admin Orchestration — Workflow definition history
 *
 * GET /api/v1/admin/orchestration/workflows/:id/definition-history
 *   Returns the workflow's current `workflowDefinition` plus the
 *   `workflowDefinitionHistory` array (newest first). Each entry carries
 *   an explicit `versionIndex` field referencing the raw (oldest→newest)
 *   DB array position — the same value `/definition-revert` expects.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';
import {
  workflowDefinitionHistorySchema,
  type WorkflowDefinitionHistoryEntry,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseWorkflowId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseWorkflowId(rawId);

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      workflowDefinition: true,
      workflowDefinitionHistory: true,
    },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  const parsed = workflowDefinitionHistorySchema.safeParse(workflow.workflowDefinitionHistory);
  let entries: WorkflowDefinitionHistoryEntry[];
  if (parsed.success) {
    entries = parsed.data;
  } else {
    logger.warn('definition-history: malformed history JSON, returning empty array', {
      workflowId: id,
      issues: parsed.error.issues,
    });
    entries = [];
  }

  const annotated = entries.map((entry, versionIndex) => ({ ...entry, versionIndex }));
  const history = annotated.reverse();

  log.info('Workflow definition history fetched', { workflowId: id, entries: history.length });

  return successResponse({
    workflowId: workflow.id,
    slug: workflow.slug,
    current: workflow.workflowDefinition,
    history,
  });
});
