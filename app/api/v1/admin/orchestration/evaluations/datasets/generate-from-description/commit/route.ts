/**
 * Admin Orchestration — Generate cases from description (commit).
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit
 *   Creates a new dataset row + writes the admin-reviewed cases in a
 *   single Prisma transaction. The sibling preview route returned the
 *   proposals; the admin reviewed/edited and is committing here. No
 *   LLM call.
 *
 *   The dataset's `source` is stamped `'synthetic'` to mirror the
 *   sibling `/datasets/[id]/generate-cases/commit` route — the
 *   per-case `metadata.mode = 'description'` distinguishes
 *   description-mode generations from KB / failure-mining in the UI.
 *
 * Inherits the default 100/min rate limit.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { generateFromDescriptionCommitSchema } from '@/lib/validations/orchestration-evaluations';
import { hashParsedCases } from '@/lib/orchestration/evaluations/datasets/hash';

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, generateFromDescriptionCommitSchema);

  const contentHash = hashParsedCases(body.cases);
  const dataset = await prisma.$transaction(async (tx) => {
    const created = await tx.aiDataset.create({
      data: {
        userId: session.user.id,
        name: body.name,
        description: body.description ?? null,
        tags: body.tags ?? [],
        caseCount: body.cases.length,
        contentHash,
        source: 'synthetic',
      },
    });
    await tx.aiDatasetCase.createMany({
      data: body.cases.map((c, i) => ({
        datasetId: created.id,
        position: i,
        input: c.input as Prisma.InputJsonValue,
        expectedOutput: c.expectedOutput ?? null,
        metadata: c.metadata !== undefined ? (c.metadata as Prisma.InputJsonValue) : undefined,
        referenceCitations:
          c.referenceCitations !== undefined
            ? (c.referenceCitations as Prisma.InputJsonValue)
            : undefined,
      })),
    });
    return created;
  });

  log.info('Committed description-mode dataset', {
    datasetId: dataset.id,
    caseCount: body.cases.length,
  });
  return successResponse(
    { datasetId: dataset.id, caseCount: body.cases.length, contentHash, warnings: [] },
    undefined,
    { status: 201 }
  );
});
