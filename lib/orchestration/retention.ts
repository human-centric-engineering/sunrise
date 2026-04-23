/**
 * Retention Policy Enforcement
 *
 * Deletes conversations (and their messages, embeddings, cost logs)
 * that exceed the per-agent retention window. Also prunes old webhook
 * delivery records, cost log rows, and admin audit log rows based on
 * global settings.
 *
 * Agents with `retentionDays = null` keep conversations forever.
 * Settings with `webhookRetentionDays`, `costLogRetentionDays`, or
 * `auditLogRetentionDays` set to `null` skip the respective pruning.
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
  /** Number of webhook delivery rows pruned. */
  webhookDeliveriesDeleted: number;
  /** Number of cost log rows pruned. */
  costLogsDeleted: number;
  /** Number of admin audit log rows pruned. */
  auditLogsDeleted: number;
}

/**
 * Enforce retention policies for all agents that have `retentionDays` set,
 * then prune old webhook deliveries and cost logs per global settings.
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

  const webhookResult = await pruneWebhookDeliveries();
  const costLogResult = await pruneCostLogs();
  const auditLogResult = await pruneAuditLogs();

  return {
    deleted: totalDeleted,
    agentsProcessed: agents.length,
    webhookDeliveriesDeleted: webhookResult.deleted,
    costLogsDeleted: costLogResult.deleted,
    auditLogsDeleted: auditLogResult.deleted,
  };
}

// ============================================================================
// Webhook and Cost Log Pruning
// ============================================================================

export interface PruneResult {
  deleted: number;
}

/**
 * Delete webhook delivery rows older than `maxAgeDays`.
 * Reads `webhookRetentionDays` from AiOrchestrationSettings if not passed.
 * Skips if no value is configured.
 */
export async function pruneWebhookDeliveries(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('webhookRetentionDays'));
  if (days === null) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.aiWebhookDelivery.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info('Webhook delivery rows pruned', { deleted: result.count, maxAgeDays: days });
  }
  return { deleted: result.count };
}

/**
 * Delete cost log rows older than `maxAgeDays`.
 * Reads `costLogRetentionDays` from AiOrchestrationSettings if not passed.
 * Skips if no value is configured.
 */
export async function pruneCostLogs(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('costLogRetentionDays'));
  if (days === null) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.aiCostLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info('Cost log rows pruned', { deleted: result.count, maxAgeDays: days });
  }
  return { deleted: result.count };
}

/**
 * Delete admin audit log rows older than `maxAgeDays`.
 * Reads `auditLogRetentionDays` from AiOrchestrationSettings if not passed.
 * Skips if no value is configured.
 */
export async function pruneAuditLogs(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('auditLogRetentionDays'));
  if (days === null) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.aiAdminAuditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info('Admin audit log rows pruned', { deleted: result.count, maxAgeDays: days });
  }
  return { deleted: result.count };
}

/** Read a named retention column from the singleton settings row. */
async function resolveRetentionDays(
  field: 'webhookRetentionDays' | 'costLogRetentionDays' | 'auditLogRetentionDays'
): Promise<number | null> {
  try {
    const row = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { [field]: true },
    });
    return (row?.[field] as unknown as number | null) ?? null;
  } catch {
    return null;
  }
}
