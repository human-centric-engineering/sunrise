/**
 * Admin Orchestration — Agent evaluation trend
 *
 * GET /api/v1/admin/orchestration/agents/:id/evaluation-trend
 *
 * Returns one trend point per completed evaluation session for an agent,
 * sorted by `completedAt` ascending. Powers the per-agent quality chart
 * on the agent detail page.
 *
 * Ownership: scoped to the caller's user. Cross-user evaluations are
 * not exposed.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import type { EvaluationMetricSummary } from '@/lib/orchestration/evaluations';

export interface EvaluationTrendPoint {
  sessionId: string;
  title: string;
  completedAt: string;
  avgFaithfulness: number | null;
  avgGroundedness: number | null;
  avgRelevance: number | null;
  scoredLogCount: number;
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const agentId = parsed.data;

  // Confirm the agent exists. Agents are shared admin-wide so we don't
  // gate visibility here, but a missing agent should still 404.
  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

  const sessions = await prisma.aiEvaluationSession.findMany({
    where: {
      agentId,
      userId: session.user.id,
      status: 'completed',
      completedAt: { not: null },
      metricSummary: { not: null as never },
    },
    orderBy: { completedAt: 'asc' },
    select: {
      id: true,
      title: true,
      completedAt: true,
      metricSummary: true,
    },
  });

  const points: EvaluationTrendPoint[] = sessions.flatMap((s) => {
    const summary = s.metricSummary as EvaluationMetricSummary | null;
    if (!summary || !s.completedAt) return [];
    return [
      {
        sessionId: s.id,
        title: s.title,
        completedAt: s.completedAt.toISOString(),
        avgFaithfulness: summary.avgFaithfulness,
        avgGroundedness: summary.avgGroundedness,
        avgRelevance: summary.avgRelevance,
        scoredLogCount: summary.scoredLogCount,
      },
    ];
  });

  log.info('Agent evaluation trend fetched', { agentId, points: points.length });

  return successResponse({ points });
});
