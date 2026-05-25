/**
 * Admin Orchestration — Paginated dataset cases.
 *
 * GET /api/v1/admin/orchestration/evaluations/datasets/:id/cases
 *   Cursor-paginated case list. Cursor is the case's `position`
 *   (stable across edits; matches the join key in case results).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { listDatasetCasesQuerySchema } from '@/lib/validations/orchestration-evaluations';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = cuidSchema.safeParse(rawId);
  if (!id.success) {
    throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
  }
  const { searchParams } = new URL(request.url);
  const { cursor, limit } = validateQueryParams(searchParams, listDatasetCasesQuerySchema);

  const dataset = await prisma.aiDataset.findFirst({
    where: { id: id.data, userId: session.user.id },
    select: { id: true, caseCount: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${id.data} not found`);

  const cases = await prisma.aiDatasetCase.findMany({
    where: { datasetId: id.data, ...(cursor !== undefined ? { position: { gt: cursor } } : {}) },
    orderBy: { position: 'asc' },
    take: limit + 1,
  });
  const hasMore = cases.length > limit;
  const items = hasMore ? cases.slice(0, limit) : cases;
  const nextCursor = hasMore ? items[items.length - 1].position : null;

  log.info('Listed dataset cases', { datasetId: id.data, returned: items.length });
  return successResponse({ items, nextCursor, total: dataset.caseCount });
});
