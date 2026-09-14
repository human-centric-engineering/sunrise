/**
 * Admin Orchestration — Executions list
 *
 * GET /api/v1/admin/orchestration/executions
 *
 * Returns the caller's own workflow executions plus system-owned runs
 * (schedule- and inbound-triggered, `userId = null`), with optional
 * filtering by workflowId, status, and date range.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';
import { listExecutionsQuerySchema } from '@/lib/validations/orchestration';
import { WorkflowStatus } from '@/types/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, workflowId, status, startDate, endDate } = validateQueryParams(
    searchParams,
    listExecutionsQuerySchema
  );
  const skip = (page - 1) * limit;

  // Filters go in an AND alongside the visibility clause — assigning them
  // onto the same object would sit beside its `OR` and widen, not narrow.
  const filters: Prisma.AiWorkflowExecutionWhereInput = {};
  if (workflowId) filters.workflowId = workflowId;
  if (status) filters.status = status;
  if (startDate || endDate) {
    filters.createdAt = {};
    if (startDate) filters.createdAt.gte = startDate;
    if (endDate) filters.createdAt.lte = endDate;
  }

  const where: Prisma.AiWorkflowExecutionWhereInput = {
    AND: [executionVisibilityWhere(session), filters],
  };

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
