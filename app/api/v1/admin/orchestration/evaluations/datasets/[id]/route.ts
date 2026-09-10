/**
 * Admin Orchestration — Single dataset (read / patch / delete).
 *
 * GET    /api/v1/admin/orchestration/evaluations/datasets/:id
 *   Returns the dataset + the first 50 cases for preview.
 *
 * PATCH  /api/v1/admin/orchestration/evaluations/datasets/:id
 *   Rename / re-tag / edit description. Does NOT alter content hash
 *   (only `cases` writes do, via the upload endpoint).
 *
 * DELETE /api/v1/admin/orchestration/evaluations/datasets/:id
 *   Refuses to delete a dataset referenced by any non-terminal run.
 *   Cascades AiDatasetCase rows.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import {
  datasetVisibilityWhere,
  datasetAccessBasis,
  logDatasetAccess,
} from '@/lib/orchestration/access/dataset-access';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ConflictError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { patchDatasetSchema } from '@/lib/validations/orchestration-evaluations';

/**
 * The dataset, if this caller may see it — theirs, or one nobody owns where the
 * policy allows (t-679). A miss is a 404 rather than a 403: "it exists but is
 * not yours" is an id-enumeration vector.
 *
 * Returns the row and its access basis, because a caller acting on a row that
 * is not their own has to say so in the audit log.
 */
async function loadDataset(id: string, session: AuthenticatedSession) {
  const dataset = await prisma.aiDataset.findFirst({
    where: { AND: [await datasetVisibilityWhere(session), { id }] },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${id} not found`);
  const basis = datasetAccessBasis(dataset, session.user.id);
  // The query above admits only 'owner' and 'orphan' rows, so this cannot be
  // null — narrowing for the type, not re-checking the boundary.
  if (!basis) throw new NotFoundError(`Dataset ${id} not found`);
  return { dataset, basis };
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'dataset id' });

  const { dataset, basis } = await loadDataset(id, session);
  const cases = await prisma.aiDatasetCase.findMany({
    where: { datasetId: id },
    orderBy: { position: 'asc' },
    take: 50,
  });
  logDatasetAccess({
    adminUserId: session.user.id,
    datasetId: id,
    datasetName: dataset.name,
    basis,
    action: 'dataset.viewed',
    clientIp: getClientIP(request),
  });
  log.info('Loaded dataset', { datasetId: id, casePreviewCount: cases.length });
  return successResponse({ dataset, cases });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'dataset id' });

  const { dataset, basis } = await loadDataset(id, session);
  const body = await validateRequestBody(request, patchDatasetSchema);
  // Pinned to the ownership the read saw. An orphan can now be claimed, so
  // `userId` has a null -> someone transition it did not have before; without
  // this an admin could edit a dataset another claimed in the window.
  const updated = await prisma.aiDataset.update({
    where: { id, userId: dataset.userId },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
    },
  });
  logDatasetAccess({
    adminUserId: session.user.id,
    datasetId: id,
    datasetName: updated.name,
    basis,
    action: 'dataset.updated',
    extra: { fields: Object.keys(body) },
    clientIp: getClientIP(request),
  });
  log.info('Dataset patched', { datasetId: id, fields: Object.keys(body) });
  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'dataset id' });

  const { dataset, basis } = await loadDataset(id, session);
  // Block delete when a non-terminal run still references this dataset —
  // worker must not pick up a run mid-delete and fail mid-pipeline.
  const blockingRun = await prisma.aiEvaluationRun.findFirst({
    where: { datasetId: id, status: { in: ['queued', 'running'] } },
    select: { id: true, name: true, status: true },
  });
  if (blockingRun) {
    throw new ConflictError(
      `Cannot delete dataset: it is referenced by an active run "${blockingRun.name}" (${blockingRun.status})`
    );
  }

  // Pinned to the ownership the read saw — see the PATCH handler.
  await prisma.aiDataset.delete({ where: { id, userId: dataset.userId } });
  logDatasetAccess({
    adminUserId: session.user.id,
    datasetId: id,
    datasetName: dataset.name,
    basis,
    action: 'dataset.deleted',
    clientIp: getClientIP(request),
  });
  log.info('Dataset deleted', { datasetId: id });
  return successResponse({ deleted: true, id });
});
