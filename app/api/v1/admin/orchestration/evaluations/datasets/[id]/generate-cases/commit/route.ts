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
import {
  datasetVisibilityWhere,
  datasetAccessBasis,
  logDatasetAccess,
} from '@/lib/orchestration/access/dataset-access';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { generateCasesCommitSchema } from '@/lib/validations/orchestration-evaluations';
import { appendCasesToDataset } from '@/lib/orchestration/evaluations/datasets/append-cases';

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = cuidSchema.safeParse(rawId);
    if (!id.success) {
      throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
    }
    const datasetId = id.data;

    const body = await validateRequestBody(request, generateCasesCommitSchema);

    const dataset = await prisma.aiDataset.findFirst({
      where: { AND: [await datasetVisibilityWhere(session), { id: datasetId }] },
      select: { id: true, name: true, userId: true },
    });
    if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

    const result = await appendCasesToDataset({
      datasetId,
      cases: body.cases,
      source: 'synthetic',
      observedOwnerId: dataset.userId,
    });

    logDatasetAccess({
      adminUserId: session.user.id,
      datasetId: datasetId,
      datasetName: dataset.name,
      // The visibility clause admits only owner and orphan rows, so this
      // cannot be null. If it somehow were, over-logging is the safe direction.
      basis: datasetAccessBasis(dataset, session.user.id) ?? 'orphan',
      action: 'dataset.cases_commit',
      clientIp: getClientIP(request),
    });
    log.info('Committed synthetic cases', {
      datasetId,
      appendedCount: result.appendedCount,
      newCaseCount: result.newCaseCount,
    });
    return successResponse(result, undefined, { status: 201 });
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Resolves the dataset under the visible clause for this caller — rows they own, or rows nobody owns where canRead permits an unattributed read — before touching it. Never a row belonging to another subject.',
    },
  }
);
