/**
 * Admin Orchestration — Get execution status (lightweight)
 *
 * GET /api/v1/admin/orchestration/executions/:id/status
 *
 * Returns a narrow projection of `AiWorkflowExecution` suited to high-frequency
 * polling — no executionTrace, no inputData, no outputData, no workflow join.
 * Callers needing the full row + parsed trace use `/executions/:id`.
 *
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered). Another admin's own run returns 404
 * (not 403) — we never confirm existence of a row the caller cannot see.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      status: true,
      currentStep: true,
      errorMessage: true,
      totalTokensUsed: true,
      totalCostUsd: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      userId: true,
    },
  });
  if (!execution || !adminCanViewExecution(execution, session)) {
    throw new NotFoundError(`Execution ${parsed.data} not found`);
  }

  const { userId: _userId, ...payload } = execution;
  return successResponse(payload);
});
