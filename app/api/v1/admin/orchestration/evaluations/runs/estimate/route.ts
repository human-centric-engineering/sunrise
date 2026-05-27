/**
 * Admin Orchestration — Evaluation run cost estimate.
 *
 * POST /api/v1/admin/orchestration/evaluations/runs/estimate
 *   Returns the predicted USD cost of a queued batch run given the
 *   agent + judge slugs + dataset the run-create form has selected.
 *   Body is small, read-only — no rate-limit sub-cap; inherits the
 *   default 100/min from the proxy.
 *
 * Ownership: dataset must belong to the caller. The subject agent is
 * looked up by id (read-only); we don't enforce ownership beyond that
 * because the form only ever submits agents the caller can already see
 * in their picker.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { estimateRunCostSchema } from '@/lib/validations/orchestration-evaluations';
import { estimateEvaluationRunCost } from '@/lib/orchestration/cost-estimation/evaluation-cost';

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, estimateRunCostSchema);

  // Dataset ownership — same posture as the run-create route.
  const dataset = await prisma.aiDataset.findFirst({
    where: { id: body.datasetId, userId: session.user.id },
    select: { id: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${body.datasetId} not found`);

  const estimate = await estimateEvaluationRunCost({
    subjectKind: body.subjectKind,
    ...(body.agentId ? { agentId: body.agentId } : {}),
    ...(body.workflowId ? { workflowId: body.workflowId } : {}),
    userId: session.user.id,
    judgeAgentSlugs: body.judgeAgentSlugs,
    datasetId: body.datasetId,
    ...(body.caseCount !== undefined ? { caseCount: body.caseCount } : {}),
  });

  log.info('Eval run cost estimated', {
    subjectKind: body.subjectKind,
    agentId: body.agentId,
    workflowId: body.workflowId,
    datasetId: body.datasetId,
    judgeCount: body.judgeAgentSlugs.length,
    basedOn: estimate.basedOn,
    midUsd: estimate.midUsd,
  });
  return successResponse(estimate);
});
