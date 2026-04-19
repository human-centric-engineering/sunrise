/**
 * Retention Policy Enforcement
 *
 * Deletes conversations (and their messages, embeddings, cost logs)
 * that exceed the per-agent retention window. Agents with
 * `retentionDays = null` keep conversations forever.
 *
 * Called by the unified maintenance tick endpoint.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export interface RetentionResult {
  /** Number of conversations deleted. */
  deleted: number;
  /** Number of agents with retention policies. */
  agentsProcessed: number;
}

/**
 * Enforce retention policies for all agents that have `retentionDays` set.
 *
 * For each agent, deletes conversations whose `updatedAt` is older than
 * `now - retentionDays`. Cascade deletes handle messages, embeddings,
 * and cost logs.
 */
export async function enforceRetentionPolicies(): Promise<RetentionResult> {
  const agents = await prisma.aiAgent.findMany({
    where: { retentionDays: { not: null } },
    select: { id: true, slug: true, retentionDays: true },
  });

  if (agents.length === 0) return { deleted: 0, agentsProcessed: 0 };

  let totalDeleted = 0;

  for (const agent of agents) {
    const cutoff = new Date(Date.now() - agent.retentionDays! * 24 * 60 * 60 * 1000);

    const result = await prisma.aiConversation.deleteMany({
      where: {
        agentId: agent.id,
        updatedAt: { lt: cutoff },
      },
    });

    if (result.count > 0) {
      totalDeleted += result.count;
      logger.info('Retention policy enforced', {
        agentSlug: agent.slug,
        retentionDays: agent.retentionDays,
        deletedConversations: result.count,
      });
    }
  }

  return { deleted: totalDeleted, agentsProcessed: agents.length };
}
