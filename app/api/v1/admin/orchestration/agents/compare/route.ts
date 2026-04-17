/**
 * Admin Orchestration — Agent performance comparison
 *
 * GET /api/v1/admin/orchestration/agents/compare?agentIds=id1,id2
 *
 * Compares two agents side-by-side: configuration, cost totals,
 * conversation counts, evaluation summaries, and capability counts.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';

const querySchema = z.object({
  agentIds: z
    .string()
    .transform((val) => val.split(',').map((s) => s.trim()))
    .pipe(z.array(cuidSchema).length(2, 'Exactly 2 agent IDs required')),
});

async function getAgentStats(agentId: string) {
  const [agent, costAgg, conversationCount, capabilityCount, evalTotal, evalCompleted] =
    await Promise.all([
      prisma.aiAgent.findUnique({
        where: { id: agentId },
        select: {
          id: true,
          name: true,
          slug: true,
          model: true,
          provider: true,
          isActive: true,
          createdAt: true,
        },
      }),
      prisma.aiCostLog.aggregate({
        where: { agentId },
        _sum: { totalCostUsd: true, inputTokens: true, outputTokens: true },
        _count: true,
      }),
      prisma.aiConversation.count({ where: { agentId } }),
      prisma.aiAgentCapability.count({ where: { agentId } }),
      prisma.aiEvaluationSession.count({ where: { agentId } }),
      prisma.aiEvaluationSession.count({ where: { agentId, status: 'completed' } }),
    ]);

  if (!agent) return null;

  return {
    ...agent,
    totalCostUsd: costAgg._sum.totalCostUsd ?? 0,
    totalInputTokens: costAgg._sum.inputTokens ?? 0,
    totalOutputTokens: costAgg._sum.outputTokens ?? 0,
    llmCallCount: costAgg._count,
    conversationCount,
    capabilityCount,
    evaluations: {
      total: evalTotal,
      completed: evalCompleted,
    },
  };
}

export const GET = withAdminAuth(async (request) => {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ agentIds: url.searchParams.get('agentIds') ?? '' });
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters', {
      agentIds: parsed.error.issues.map((e) => e.message),
    });
  }

  const [idA, idB] = parsed.data.agentIds;
  const [agentA, agentB] = await Promise.all([getAgentStats(idA), getAgentStats(idB)]);

  const missing = [];
  if (!agentA) missing.push(idA);
  if (!agentB) missing.push(idB);
  if (missing.length > 0) {
    throw new ValidationError('Agent(s) not found', {
      agentIds: missing.map((id) => `Agent ${id} not found`),
    });
  }

  return successResponse({ agents: [agentA, agentB] });
});
