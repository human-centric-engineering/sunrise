/**
 * Retention Policy Enforcement
 *
 * Deletes conversations (and their messages, embeddings, cost logs)
 * that exceed the per-agent retention window. Also prunes old webhook
 * subscription delivery records, event-hook delivery records, cost log
 * rows, admin audit log rows, workflow-execution history, evaluation
 * history, and MCP audit-log rows based on global settings.
 *
 * Agents with `retentionDays = null` keep conversations forever.
 * Settings with `webhookRetentionDays`, `costLogRetentionDays`,
 * `auditLogRetentionDays`, `executionRetentionDays`, or
 * `evaluationRetentionDays` set to `null` skip the respective pruning.
 * Event-hook deliveries share the `webhookRetentionDays` window —
 * they are the same class of outbound-dispatch audit data. MCP audit
 * rows use `McpServerConfig.auditRetentionDays` (default 90, always on).
 *
 * Execution and evaluation prunes delete only TERMINAL rows — in-flight
 * work (running / pending / awaiting-approval executions; queued /
 * running / in-progress eval runs and sessions) is never pruned by age.
 *
 * Called by the unified maintenance tick endpoint.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';

export interface RetentionResult {
  /** Number of conversations deleted. */
  deleted: number;
  /** Number of agents with retention policies. */
  agentsProcessed: number;
  /** Number of webhook subscription delivery rows pruned. */
  webhookDeliveriesDeleted: number;
  /** Number of event-hook delivery rows pruned. */
  hookDeliveriesDeleted: number;
  /** Number of cost log rows pruned. */
  costLogsDeleted: number;
  /** Number of admin audit log rows pruned. */
  auditLogsDeleted: number;
  /** Number of terminal workflow executions pruned (cascades steps/dispatches/lease events/cost logs). */
  executionsDeleted: number;
  /** Number of terminal evaluation sessions pruned (cascades logs). */
  evaluationSessionsDeleted: number;
  /** Number of terminal evaluation runs pruned (cascades cases). */
  evaluationRunsDeleted: number;
  /** Number of MCP audit-log rows pruned. */
  mcpAuditLogsDeleted: number;
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
  const hookResult = await pruneHookDeliveries();
  const costLogResult = await pruneCostLogs();
  const auditLogResult = await pruneAuditLogs();
  const executionResult = await pruneExecutions();
  const evaluationResult = await pruneEvaluationData();
  const mcpAuditResult = await pruneMcpAuditLogs();

  return {
    deleted: totalDeleted,
    agentsProcessed: agents.length,
    webhookDeliveriesDeleted: webhookResult.deleted,
    hookDeliveriesDeleted: hookResult.deleted,
    costLogsDeleted: costLogResult.deleted,
    auditLogsDeleted: auditLogResult.deleted,
    executionsDeleted: executionResult.deleted,
    evaluationSessionsDeleted: evaluationResult.sessionsDeleted,
    evaluationRunsDeleted: evaluationResult.runsDeleted,
    mcpAuditLogsDeleted: mcpAuditResult.deleted,
  };
}

// ============================================================================
// Webhook and Cost Log Pruning
// ============================================================================

export interface PruneResult {
  deleted: number;
}

/**
 * Delete webhook delivery rows older than the configured retention windows.
 *
 * Splits cleanup by status so operators can keep dead-lettered failures
 * around longer than successful deliveries:
 *
 * - Non-exhausted rows (`pending` / `delivered` / `failed`) use
 *   `webhookRetentionDays`.
 * - `exhausted` rows use `webhookDlqRetentionDays`, falling back to
 *   `webhookRetentionDays` when the DLQ-specific value is null. That
 *   fallback preserves the pre-DLQ unified behaviour for environments
 *   that haven't set the new column.
 *
 * Returns the combined deletion count.
 */
export async function pruneWebhookDeliveries(
  maxAgeDays?: number,
  dlqMaxAgeDays?: number
): Promise<PruneResult> {
  const baseDays = maxAgeDays ?? (await resolveRetentionDays('webhookRetentionDays'));
  const dlqDays =
    dlqMaxAgeDays ?? (await resolveRetentionDays('webhookDlqRetentionDays')) ?? baseDays;

  let deleted = 0;

  if (baseDays !== null) {
    const cutoff = new Date(Date.now() - baseDays * 24 * 60 * 60 * 1000);
    const result = await prisma.aiWebhookDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ['pending', 'delivered', 'failed'] },
      },
    });
    if (result.count > 0) {
      logger.info('Webhook delivery rows pruned', {
        deleted: result.count,
        maxAgeDays: baseDays,
        scope: 'non-exhausted',
      });
    }
    deleted += result.count;
  }

  if (dlqDays !== null) {
    const cutoff = new Date(Date.now() - dlqDays * 24 * 60 * 60 * 1000);
    const result = await prisma.aiWebhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff }, status: 'exhausted' },
    });
    if (result.count > 0) {
      logger.info('Webhook DLQ rows pruned', {
        deleted: result.count,
        maxAgeDays: dlqDays,
        scope: 'exhausted',
      });
    }
    deleted += result.count;
  }

  return { deleted };
}

/**
 * Delete event-hook delivery rows older than `maxAgeDays`.
 * Shares the `webhookRetentionDays` setting with outbound webhook
 * subscriptions — the two are the same class of dispatch-audit data.
 * Skips if no value is configured.
 */
export async function pruneHookDeliveries(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('webhookRetentionDays'));
  if (days === null) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.aiEventHookDelivery.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info('Event-hook delivery rows pruned', { deleted: result.count, maxAgeDays: days });
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

// ============================================================================
// Execution, Evaluation, and MCP-audit Pruning
// ============================================================================

/**
 * Delete TERMINAL workflow executions older than `maxAgeDays`.
 * Reads `executionRetentionDays` from AiOrchestrationSettings if not passed.
 * Skips if no value is configured.
 *
 * Only `completed` / `failed` / `cancelled` executions are pruned — in-flight
 * work (`running`, `pending`, `paused_for_approval`) is never deleted by age,
 * however old it is. The cascade removes step dispatches, running steps, lease
 * events, and per-step cost logs; the rerun-lineage self-relation is SetNull so
 * a pruned parent doesn't take its reruns with it. Inbound-trigger payloads
 * (stored in `inputData`) are removed with the execution row.
 *
 * Filtered on `createdAt` for consistency with the other prunes.
 */
export async function pruneExecutions(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('executionRetentionDays'));
  if (days === null) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.aiWorkflowExecution.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      status: { in: ['completed', 'failed', 'cancelled'] },
    },
  });

  if (result.count > 0) {
    logger.info('Workflow executions pruned', { deleted: result.count, maxAgeDays: days });
  }
  return { deleted: result.count };
}

export interface EvaluationPruneResult {
  sessionsDeleted: number;
  runsDeleted: number;
}

/**
 * Delete TERMINAL evaluation history older than `maxAgeDays`.
 * Reads `evaluationRetentionDays` from AiOrchestrationSettings if not passed.
 * Skips if no value is configured.
 *
 * Prunes `AiEvaluationSession` (`completed` / `archived` — cascade removes its
 * logs) and `AiEvaluationRun` (`completed` / `failed` / `cancelled` — cascade
 * removes its cases). In-progress / draft sessions and queued / running runs
 * are never pruned by age. Experiment-variant links and rescore lineage are
 * SetNull, so pruning never breaks a retained experiment.
 *
 * Keep `evaluationRetentionDays <= executionRetentionDays`: eval runs JSON-
 * reference the executions they ran (no FK), so a longer eval window would
 * leave those references dangling once the executions are pruned.
 */
export async function pruneEvaluationData(maxAgeDays?: number): Promise<EvaluationPruneResult> {
  const days = maxAgeDays ?? (await resolveRetentionDays('evaluationRetentionDays'));
  if (days === null) return { sessionsDeleted: 0, runsDeleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const sessions = await prisma.aiEvaluationSession.deleteMany({
    where: { createdAt: { lt: cutoff }, status: { in: ['completed', 'archived'] } },
  });
  const runs = await prisma.aiEvaluationRun.deleteMany({
    where: { createdAt: { lt: cutoff }, status: { in: ['completed', 'failed', 'cancelled'] } },
  });

  if (sessions.count > 0 || runs.count > 0) {
    logger.info('Evaluation history pruned', {
      sessionsDeleted: sessions.count,
      runsDeleted: runs.count,
      maxAgeDays: days,
    });
  }
  return { sessionsDeleted: sessions.count, runsDeleted: runs.count };
}

/**
 * Delete MCP audit-log rows older than `maxAgeDays`.
 * Reads `auditRetentionDays` from the singleton `McpServerConfig` if not passed
 * (default 90). Unlike the other windows this is non-nullable, so MCP audit
 * pruning is always on — rows older than the configured window are actively
 * deleted on every tick. A value `<= 0` is treated as "skip" defensively so a
 * misconfigured zero can't wipe the whole audit trail.
 */
export async function pruneMcpAuditLogs(maxAgeDays?: number): Promise<PruneResult> {
  const days = maxAgeDays ?? (await getMcpServerConfig()).auditRetentionDays;
  if (days <= 0) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.mcpAuditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    logger.info('MCP audit log rows pruned', { deleted: result.count, maxAgeDays: days });
  }
  return { deleted: result.count };
}

/** Read a named retention column from the singleton settings row. */
async function resolveRetentionDays(
  field:
    | 'webhookRetentionDays'
    | 'webhookDlqRetentionDays'
    | 'costLogRetentionDays'
    | 'auditLogRetentionDays'
    | 'executionRetentionDays'
    | 'evaluationRetentionDays'
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
