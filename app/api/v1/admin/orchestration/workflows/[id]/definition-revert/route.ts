/**
 * Admin Orchestration — Revert workflow definition
 *
 * POST /api/v1/admin/orchestration/workflows/:id/definition-revert
 *   Body: { versionIndex: number }
 *   Replaces the current `workflowDefinition` with the value at
 *   `workflowDefinitionHistory[versionIndex]`. Before the swap, the
 *   current value is pushed onto history so the revert itself is
 *   auditable.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { logger } from '@/lib/logging';
import {
  workflowDefinitionHistorySchema,
  workflowDefinitionRevertSchema,
  workflowDefinitionSchema,
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

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseWorkflowId(rawId);

  const body = await validateRequestBody(request, workflowDefinitionRevertSchema);

  const current = await prisma.aiWorkflow.findUnique({
    where: { id },
    select: {
      id: true,
      workflowDefinition: true,
      workflowDefinitionHistory: true,
    },
  });
  if (!current) throw new NotFoundError(`Workflow ${id} not found`);

  const historyParse = workflowDefinitionHistorySchema.safeParse(current.workflowDefinitionHistory);
  if (!historyParse.success) {
    logger.warn('definition-revert: workflowDefinitionHistory malformed, refusing revert', {
      workflowId: id,
      issues: historyParse.error.issues,
    });
    throw new ValidationError('Stored definition history is malformed; cannot revert', {
      workflowDefinitionHistory: ['Malformed history — contact a DBA'],
    });
  }

  const history: WorkflowDefinitionHistoryEntry[] = historyParse.data;
  if (body.versionIndex >= history.length) {
    throw new ValidationError('versionIndex out of range', {
      versionIndex: [`Must be between 0 and ${Math.max(history.length - 1, 0)}`],
    });
  }

  const target = history[body.versionIndex];

  // Push the value we're reverting *from* onto history so it's recoverable.
  const nextHistory: WorkflowDefinitionHistoryEntry[] = [
    ...history,
    {
      definition: workflowDefinitionSchema.parse(current.workflowDefinition),
      changedAt: new Date().toISOString(),
      changedBy: session.user.id,
    },
  ];

  const workflow = await prisma.aiWorkflow.update({
    where: { id },
    data: {
      workflowDefinition: target.definition as unknown as Prisma.InputJsonValue,
      workflowDefinitionHistory: nextHistory as unknown as Prisma.InputJsonValue,
    },
  });

  log.info('Workflow definition reverted', {
    workflowId: id,
    versionIndex: body.versionIndex,
    adminId: session.user.id,
    historyLength: nextHistory.length,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'workflow.definition_revert',
    entityType: 'workflow',
    entityId: id,
    entityName: workflow.name,
    metadata: { versionIndex: body.versionIndex, historyLength: nextHistory.length },
    clientIp: clientIP,
  });

  return successResponse(workflow);
});
