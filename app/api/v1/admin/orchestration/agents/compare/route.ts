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
 * it". Narrowing the figures to the caller would rank two agents by how much
 * the viewer happened to exercise them, which is not a comparison of the agents
 * at all; the Conversations and Completed rows in `agent-comparison-view.tsx`
 * carry `better="higher"`, so the ranking is explicit there.
 *
 * `Promise.all` fetches one row and five aggregates. **Four of the five read a
 * model carrying an owner column, and could therefore be narrowed:**
 *
 *   - `aiCostLog.aggregate`   — `userId`, indexed, `SetNull`. Spend, tokens and
 *                               call count. Read owner-scoped in
 *                               `lib/privacy/export-sources.ts` for Art. 15.
 *   - `aiConversation.count`  — `userId`; every other conversation read goes
 *                               through `adminCanViewConversation`.
 *   - `aiEvaluationSession.count` x2 — `userId`; owner-scoped in the
 *                               evaluations routes.
 *
 * Only `aiAgentCapability.count` has no owner anywhere — it is configuration
 * attached to the agent.
 *
 * **A customer tier has to revisit all four**, and the labels as much as the
 * queries. "Total Cost" and "Total Evaluations" read as facts about the agent
 * because on a single-tenant install there is nobody else for them to be about;
 * under a customer tier they would report another tenant's spend and usage of a
 * shared agent. Spend is the sharpest of them. Either the figures narrow or the
 * labels say whose they are — tracked as t-688, because declaring `'nothing'`
 * here silences the runtime report that would otherwise have put this route on
 * a fork's worklist by itself.
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
        'Every aggregate is install-wide on purpose: this compares two shared agents, so the figures are about the agents rather than about the viewer. Narrowing them would rank two agents by how much the caller happened to use them. Covers all four narrowable aggregates — the cost totals, the conversation count and both evaluation counts — whose models all carry an owner column read elsewhere.',
    },
  }
);
