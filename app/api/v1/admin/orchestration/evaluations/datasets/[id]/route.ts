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
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { patchDatasetSchema } from '@/lib/validations/orchestration-evaluations';

function parseId(rawId: string): string {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

async function loadDataset(id: string, userId: string) {
  const dataset = await prisma.aiDataset.findFirst({
    where: { id, userId },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${id} not found`);
  return dataset;
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseId(rawId);

  const dataset = await loadDataset(id, session.user.id);
  const cases = await prisma.aiDatasetCase.findMany({
    where: { datasetId: id },
    orderBy: { position: 'asc' },
    take: 50,
  });
  log.info('Loaded dataset', { datasetId: id, casePreviewCount: cases.length });
  return successResponse({ dataset, cases });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseId(rawId);

  await loadDataset(id, session.user.id);
  const body = await validateRequestBody(request, patchDatasetSchema);
  const updated = await prisma.aiDataset.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
    },
  });
  log.info('Dataset patched', { datasetId: id, fields: Object.keys(body) });
  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseId(rawId);

  await loadDataset(id, session.user.id);
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

  await prisma.aiDataset.delete({ where: { id } });
  log.info('Dataset deleted', { datasetId: id });
  return successResponse({ deleted: true, id });
});
