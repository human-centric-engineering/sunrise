/**
 * Admin Orchestration — Get execution detail
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * Returns the `AiWorkflowExecution` row plus a parsed `trace` array and
 * a small projection suitable for the execution panel UI.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404 (not 403) — we never confirm existence of another user's
 * row.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';
import { executionTraceSchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  return successResponse({
    execution: {
      id: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
      totalTokensUsed: execution.totalTokensUsed,
      totalCostUsd: execution.totalCostUsd,
      budgetLimitUsd: execution.budgetLimitUsd,
      currentStep: execution.currentStep,
      inputData: execution.inputData,
      outputData: execution.outputData,
      errorMessage: execution.errorMessage,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
    },
    trace,
  });
});
