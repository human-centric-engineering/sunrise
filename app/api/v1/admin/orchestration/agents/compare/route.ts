/**
 * Admin Orchestration — Agent performance comparison
 *
 * GET /api/v1/admin/orchestration/agents/compare?agentIds=id1,id2
 *
 * Compares two agents side-by-side: configuration, cost totals,
 * conversation counts, evaluation summaries, and capability counts.
 *
 * Authentication: Admin role required.
 *
 * **Every figure here is install-wide, and that is the decision rather than an
 * omission (t-682).** The screen scores two shared agents against each other —
 * an `AiAgent` is configuration every admin can see and edit — so the question
 * it answers is "how much has this agent been used", not "how much have I used
 * it". Narrowing the counts to the caller would make `better="higher"` in
 * `agent-comparison-view.tsx` rank two agents by how much the viewer happened
 * to exercise them, which is not a comparison of the agents at all.
 *
 * Three of the six aggregates read models that ARE owner-scoped elsewhere:
 * `aiConversation.count` (every other conversation read goes through
 * `adminCanViewConversation`) and the two `aiEvaluationSession.count` calls.
 * They are deliberately not scoped here. `aiCostLog` and `aiAgentCapability`
 * have no owner boundary anywhere.
 *
 * **A customer tier has to revisit this**, and the labels as much as the query:
 * "Total Evaluations" reads as a fact about the agent because on a
 * single-tenant install there is no one else for it to be about. Under a
 * customer tier it would be reporting other tenants' usage of a shared agent,
 * and either the numbers narrow or the labels say whose they are.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
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

export const GET = withAdminAuth(
  async (request) => {
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
      throw new NotFoundError(`Agent(s) not found: ${missing.join(', ')}`);
    }

    return successResponse({ agents: [agentA, agentB] });
  },
  {
    ownership: {
      decidedBy: 'nothing',
      because:
        'Every aggregate is install-wide on purpose: this compares two shared agents, so the figures are about the agents rather than about the viewer. Narrowing them would rank two agents by how much the caller happened to use them. Covers the conversation count and both evaluation counts, whose models are owner-scoped elsewhere.',
    },
  }
);
