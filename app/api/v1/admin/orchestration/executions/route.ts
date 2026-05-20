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
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { listExecutionsQuerySchema } from '@/lib/validations/orchestration';
import { WorkflowStatus } from '@/types/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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

  // Only running rows can have an in-flight step. Fetching running-step
  // rows for the whole page in one shot avoids an N+1; the index on
  // `AiWorkflowRunningStep[executionId]` covers the IN clause. For
  // parallel fan-out we keep the oldest branch's start time so the
  // computed age reflects "how long has this been stuck" rather than
  // the freshest sibling.
  const runningIds = executions.filter((e) => e.status === WorkflowStatus.RUNNING).map((e) => e.id);
  const oldestStartByExecution = new Map<string, Date>();
  if (runningIds.length > 0) {
    const stepRows = await prisma.aiWorkflowRunningStep.findMany({
      where: { executionId: { in: runningIds }, completedAt: null },
      select: { executionId: true, startedAt: true },
    });
    for (const row of stepRows) {
      const existing = oldestStartByExecution.get(row.executionId);
      if (!existing || row.startedAt < existing) {
        oldestStartByExecution.set(row.executionId, row.startedAt);
      }
    }
  }

  const now = Date.now();
  const items = executions.map((execution) => {
    const oldestStart = oldestStartByExecution.get(execution.id);
    const timeInCurrentStepMs = oldestStart ? now - oldestStart.getTime() : null;
    return { ...execution, timeInCurrentStepMs };
  });

  log.info('Executions listed', { count: items.length, total });

  return paginatedResponse(items, { page, limit, total });
});
