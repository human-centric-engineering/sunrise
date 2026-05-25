/**
 * Admin Orchestration — Synthetic case generation (commit).
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/:id/generate-cases/commit
 *   Writes accepted synthetic cases to the dataset. Body carries the
 *   admin-reviewed (and possibly admin-edited) cases the sibling
 *   `/generate-cases` route returned. No LLM call — just a
 *   transactional Prisma write via `appendCasesToDataset`.
 *
 * Inherits the default 100/min rate limit.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { generateCasesCommitSchema } from '@/lib/validations/orchestration-evaluations';
import { appendCasesToDataset } from '@/lib/orchestration/evaluations/datasets/append-cases';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = cuidSchema.safeParse(rawId);
  if (!id.success) {
    throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
  }
  const datasetId = id.data;

  const body = await validateRequestBody(request, generateCasesCommitSchema);

  const dataset = await prisma.aiDataset.findFirst({
    where: { id: datasetId, userId: session.user.id },
    select: { id: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

  const result = await appendCasesToDataset({
    datasetId,
    cases: body.cases,
    source: 'synthetic',
  });

  log.info('Committed synthetic cases', {
    datasetId,
    appendedCount: result.appendedCount,
    newCaseCount: result.newCaseCount,
  });
  return successResponse(result, undefined, { status: 201 });
});
