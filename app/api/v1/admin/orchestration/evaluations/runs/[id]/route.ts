/**
 * Admin Orchestration — Single evaluation run (read).
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id
 *   Detail + summary + recent progress. The UI polls this every 3s
 *   while status='running' so per-case results land incrementally.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const idParsed = cuidSchema.safeParse(rawId);
  if (!idParsed.success) {
    throw new ValidationError('Invalid run id', { id: ['Must be a valid CUID'] });
  }
  const id = idParsed.data;
  const run = await prisma.aiEvaluationRun.findFirst({
    where: { id, userId: session.user.id },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      workflow: { select: { id: true, name: true, slug: true } },
      dataset: { select: { id: true, name: true, caseCount: true, contentHash: true } },
      _count: { select: { results: true } },
    },
  });
  if (!run) throw new NotFoundError(`Run ${id} not found`);
  log.info('Loaded run', { runId: id, status: run.status });
  return successResponse(run);
});
