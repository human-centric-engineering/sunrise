/**
 * Admin Orchestration — Per-case results for a run.
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id/cases
 *   Cursor-paginated by casePosition. Each item carries the case's
 *   subjectOutput, metricScores, latency, cost, and any errorCode —
 *   enough for the per-case drill-in UI to render without a second
 *   fetch.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { listRunCasesQuerySchema } from '@/lib/validations/orchestration-evaluations';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const idParsed = cuidSchema.safeParse(rawId);
  if (!idParsed.success) {
    throw new ValidationError('Invalid run id', { id: ['Must be a valid CUID'] });
  }
  const id = idParsed.data;
  const { searchParams } = new URL(request.url);
  const { cursor, limit } = validateQueryParams(searchParams, listRunCasesQuerySchema);

  const run = await prisma.aiEvaluationRun.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, status: true },
  });
  if (!run) throw new NotFoundError(`Run ${id} not found`);

  const results = await prisma.aiEvaluationCaseResult.findMany({
    where: { runId: id, ...(cursor !== undefined ? { casePosition: { gt: cursor } } : {}) },
    orderBy: { casePosition: 'asc' },
    take: limit + 1,
    include: {
      datasetCase: { select: { input: true, expectedOutput: true, metadata: true } },
    },
  });
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? items[items.length - 1].casePosition : null;
  log.info('Listed run case results', { runId: id, returned: items.length });
  return successResponse({ items, nextCursor });
});
