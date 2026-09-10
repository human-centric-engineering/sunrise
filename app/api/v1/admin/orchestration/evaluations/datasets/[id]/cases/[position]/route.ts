/**
 * Admin Orchestration — Single dataset case (patch).
 *
 * PATCH /api/v1/admin/orchestration/evaluations/datasets/:id/cases/:position
 *   Edits one case in place. Re-hashes the dataset and updates
 *   `contentHash` + `updatedAt` so the dataset reflects its new state.
 *
 * Safe for past runs: `AiEvaluationRun.datasetContentHash` is pinned
 * at queue time. Edits only affect future runs queued after the patch.
 *
 * Position is the stable join key against `AiEvaluationCaseResult` —
 * it does NOT move when a case is edited. Drill-ins into past runs
 * continue to show the case's state as of that run via the persisted
 * result row, not via the (now-different) case content.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { patchDatasetCaseSchema } from '@/lib/validations/orchestration-evaluations';
import { hashDatasetCases } from '@/lib/orchestration/evaluations/datasets/hash';

export const PATCH = withAdminAuth<{ id: string; position: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);

    const { id: rawId, position: rawPosition } = await params;
    const id = cuidSchema.safeParse(rawId);
    if (!id.success) {
      throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
    }
    const position = Number(rawPosition);
    if (!Number.isInteger(position) || position < 0) {
      throw new ValidationError('Invalid case position', {
        position: ['Must be a non-negative integer'],
      });
    }
    const datasetId = id.data;

    const body = await validateRequestBody(request, patchDatasetCaseSchema);

    const dataset = await prisma.aiDataset.findFirst({
      where: { AND: [await datasetVisibilityWhere(session), { id: datasetId }] },
      // `userId` so the write below can pin itself to the ownership this read
      // saw — not for the boundary test, which the `where` above settles.
      select: { id: true, userId: true },
    });
    if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

    const existing = await prisma.aiDatasetCase.findUnique({
      where: { datasetId_position: { datasetId, position } },
    });
    if (!existing) {
      throw new NotFoundError(`Case at position ${position} not found in dataset ${datasetId}`);
    }

    // Apply the patch + re-hash + update the dataset's contentHash in
    // one transaction. A `FOR UPDATE` lock on the parent dataset row
    // serialises concurrent PATCHes against the same dataset, so the
    // `findMany` below always sees a coherent snapshot of sibling cases
    // and the recomputed `contentHash` reflects every committed edit.
    // Without this lock, READ COMMITTED would let two concurrent PATCHes
    // each miss the other's case update when hashing, leaving the dataset
    // hash stale and triggering spurious `dataset_changed_post_submit`
    // failures on subsequent eval runs.
    const { updatedCase, newHash } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AiDataset" WHERE id = ${datasetId} FOR UPDATE`;

      const data: Prisma.AiDatasetCaseUpdateInput = {};
      if (body.input !== undefined) data.input = body.input as Prisma.InputJsonValue;
      if (body.expectedOutput !== undefined) data.expectedOutput = body.expectedOutput;
      if (body.metadata !== undefined) {
        data.metadata =
          body.metadata === null ? Prisma.JsonNull : (body.metadata as Prisma.InputJsonValue);
      }
      if (body.referenceCitations !== undefined) {
        data.referenceCitations =
          body.referenceCitations === null
            ? Prisma.JsonNull
            : (body.referenceCitations as Prisma.InputJsonValue);
      }

      const updated = await tx.aiDatasetCase.update({
        where: { datasetId_position: { datasetId, position } },
        data,
      });

      const allCases = await tx.aiDatasetCase.findMany({
        where: { datasetId },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          input: true,
          expectedOutput: true,
          metadata: true,
          referenceCitations: true,
        },
      });
      const recomputed = hashDatasetCases(allCases);

      // Pinned to the ownership the visibility check saw, like every other
      // dataset write. An orphan can now be claimed mid-request, and a case
      // edit landing on a dataset somebody else just adopted is a surprise for
      // both of them.
      await tx.aiDataset.update({
        where: { id: datasetId, userId: dataset.userId },
        data: { contentHash: recomputed, updatedAt: new Date() },
      });

      return { updatedCase: updated, newHash: recomputed };
    });

    log.info('Dataset case patched', {
      datasetId,
      position,
      fields: Object.keys(body),
      newContentHash: newHash,
    });
    return successResponse({ case: updatedCase, contentHash: newHash });
  }
);
