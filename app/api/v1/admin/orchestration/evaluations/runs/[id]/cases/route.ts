/**
 * Admin Orchestration — Per-case results for a run.
 *
 * GET /api/v1/admin/orchestration/evaluations/runs/:id/cases
 *   Cursor-paginated by casePosition. Each item carries the case's
 *   subjectOutput, metricScores, latency, cost, and any errorCode —
 *   enough for the per-case drill-in UI to render without a second
 *   fetch. `datasetCase` is `null` when the run's dataset is no longer
 *   one the caller may see (another member claimed it).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { listRunCasesQuerySchema } from '@/lib/validations/orchestration-evaluations';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { loadScoredCases } from '@/lib/orchestration/evaluations/datasets/scored-cases';

export const GET = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
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
      where: {
        runId: id,
        // The run checked above, named again so the owner layer sees the read is
        // confined to the caller's run.
        run: { userId: session.user.id },
        ...(cursor !== undefined ? { casePosition: { gt: cursor } } : {}),
      },
      orderBy: { casePosition: 'asc' },
      take: limit + 1,
    });
    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore ? page[page.length - 1].casePosition : null;

    // The cases these results scored, through the dataset's visibility: `null`
    // when the dataset has since become another member's (`scored-cases.ts`).
    const cases = await loadScoredCases(
      page.map((r) => r.datasetCaseId),
      datasetVisibilityWhere(session)
    );
    const items = page.map((r) => ({ ...r, datasetCase: cases.get(r.datasetCaseId) ?? null }));
    log.info('Listed run case results', { runId: id, returned: items.length });
    return successResponse({ items, nextCursor });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Scoped to the evaluation sessions, runs and datasets this caller owns — and ownerless datasets where the policy permits them — keyed on the caller's id. Never another member's.",
    },
  }
);
