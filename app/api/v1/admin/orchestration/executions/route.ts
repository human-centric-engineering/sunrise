/**
 * Admin Orchestration — Executions list
 *
 * GET /api/v1/admin/orchestration/executions
 *
 * Returns the caller's own workflow executions with optional filtering
 * by workflowId, status, and date range. Scoped to `session.user.id`.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { listExecutionsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, workflowId, status, startDate, endDate } = validateQueryParams(
    searchParams,
    listExecutionsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiWorkflowExecutionWhereInput = {
    userId: session.user.id,
  };
  if (workflowId) where.workflowId = workflowId;
  if (status) where.status = status;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const [executions, total] = await Promise.all([
    prisma.aiWorkflowExecution.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        workflow: { select: { id: true, name: true } },
      },
    }),
    prisma.aiWorkflowExecution.count({ where }),
  ]);

  log.info('Executions listed', { count: executions.length, total });

  return paginatedResponse(executions, { page, limit, total });
});
