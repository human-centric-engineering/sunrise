/**
 * One agent's figures for the comparison screen
 * (`GET /api/v1/admin/orchestration/agents/compare`).
 *
 * **Every figure is the caller's org's, and crosses owners inside it on
 * purpose.** Two different mechanisms answer the two axes, and neither is a
 * `where` clause here:
 *
 *   - **Between orgs — row isolation (§107).** All five models read carry
 *     `orgId` and are tenant-owned (`lib/tenancy/classification.ts`), so at
 *     `TENANCY_MODE=multi` the `org_isolation` policy bounds every read below
 *     to the org the request entered. Another org's agent is not found, so the
 *     route answers 404; its spend and usage cannot reach a sum. No agent is
 *     shared between orgs — `AiAgent.slug` is unique per org (t-708) and each
 *     org has its own platform agents (§116) — so there is no shared agent whose
 *     figures could mix two orgs. Cost rows detached by an org's erasure carry
 *     no org and are visible to none. At `single` there is one org, so the
 *     figures are the install's. An unbound admin API key enters no org
 *     (`withAdminAuth`), so at `multi` it finds no agent and gets a 404 here,
 *     as it does on every tenant-owned read (`.context/tenancy/isolation.md`).
 *   - **Between owners inside the org — a decision (t-682, §115).** The screen
 *     compares two agents, so the question it answers is "how much has this
 *     agent been used", not "how much have I used it". Narrowing to the caller
 *     would rank two agents by how much the viewer happened to exercise them;
 *     the Conversations and Completed rows in `agent-comparison-view.tsx`
 *     carry `better="higher"`, so the ranking is explicit there. The
 *     conversation and evaluation counts therefore run inside
 *     `runAcrossOwners`, and `AiCostLog` is `not-personal` in
 *     `lib/db/owner-classification.ts`. Counts and sums only — no row of
 *     anyone's leaves here.
 *
 * `scripts/smoke/tenancy-isolation.ts` ([3b]) proves both against real
 * Postgres with the policies forced: two orgs with spend, conversations and
 * evaluations each, read as a narrowed org admin of one of them (t-688).
 *
 * Returns `null` when the agent is not visible to the caller, which the route
 * answers with a 404.
 */

import { runAcrossOwners } from '@/lib/auth/subject-context';
import { prisma } from '@/lib/db/client';

export interface AgentComparisonStats {
  id: string;
  name: string;
  slug: string;
  model: string;
  provider: string;
  isActive: boolean;
  createdAt: Date;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCallCount: number;
  conversationCount: number;
  capabilityCount: number;
  evaluations: { total: number; completed: number };
}

export async function getAgentComparisonStats(
  agentId: string
): Promise<AgentComparisonStats | null> {
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
      // The org's, by row isolation; every owner's in it, by decision (header).
      runAcrossOwners('agent comparison: an org-wide conversation count per agent', () =>
        prisma.aiConversation.count({ where: { agentId } })
      ),
      prisma.aiAgentCapability.count({ where: { agentId } }),
      // The same two axes (header): two numbers per agent, no session row.
      runAcrossOwners('agent comparison: an org-wide evaluation count per agent', () =>
        prisma.aiEvaluationSession.count({ where: { agentId } })
      ),
      runAcrossOwners('agent comparison: an org-wide evaluation count per agent', () =>
        prisma.aiEvaluationSession.count({ where: { agentId, status: 'completed' } })
      ),
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
