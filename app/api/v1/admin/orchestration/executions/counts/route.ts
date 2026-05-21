/**
 * Admin Orchestration — Execution status counts
 *
 * GET /api/v1/admin/orchestration/executions/counts?statuses=pending,running,paused_for_approval
 *
 * Returns the caller's own execution count per requested status as a single
 * groupBy query. Drives the admin-sidebar badge polling that previously
 * fanned out into N list-endpoint requests. Scoped to `session.user.id`.
 *
 * Response shape:
 *   { counts: { [status]: number } }
 *
 * Every requested status appears in the response — statuses with no rows
 * are zero-filled so the caller can read keys directly without defaulting.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { executionCountsQuerySchema } from '@/lib/validations/orchestration';
import type { WorkflowStatus } from '@/types/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { statuses } = validateQueryParams(searchParams, executionCountsQuerySchema);

  const grouped = await prisma.aiWorkflowExecution.groupBy({
    by: ['status'],
    where: { userId: session.user.id, status: { in: statuses } },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = 0;
  for (const row of grouped) counts[row.status] = row._count._all;

  log.info('Execution counts computed', {
    statuses,
    total: Object.values(counts).reduce((acc, n) => acc + n, 0),
  });

  return successResponse({ counts: counts as Record<WorkflowStatus, number> });
});
