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
 * **Two sweeps, two tenant scopes (§108 t-711).** `enforceRetentionPolicies`
 * prunes tenant-owned tables and runs once per org inside that org's scope
 * (the `retention` platform job); `enforceSystemRetentionPolicies` prunes the
 * two system audit tables — `AiAdminAuditLog`, `McpAuditLog`, neither of
 * which has an org — and runs once under the audited system scope (the
 * `auditLogRetention` job). Per org they would have run N times over the
 * same rows. Both are driven by the unified maintenance tick.
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
  /** Number of terminal workflow executions pruned (cascades steps/dispatches/lease events/cost logs). */
  executionsDeleted: number;
  /** Number of terminal evaluation sessions pruned (cascades logs). */
  evaluationSessionsDeleted: number;
  /** Number of terminal evaluation runs pruned (cascades cases). */
  evaluationRunsDeleted: number;
}

/** What the system-scoped audit sweep reports. */
export interface SystemRetentionResult {
  /** Number of admin audit log rows pruned. */
  auditLogsDeleted: number;
  /** Number of MCP audit-log rows pruned. */
  mcpAuditLogsDeleted: number;
}

/**
 * Enforce retention policies for all agents that have `retentionDays` set,
 * then prune old webhook deliveries, cost logs, executions and evaluation
 * history per global settings.
 *
 * For each agent, deletes conversations whose `updatedAt` is older than
 * `now - retentionDays`. Cascade deletes handle messages, embeddings,
 * and cost logs.
 *
 * Every table this sweep touches is tenant-owned, so it runs inside an org
 * scope — once per org at `multi`, where the policies confine each prune to
 * that org's rows; the two system audit tables are
 * {@link enforceSystemRetentionPolicies}' job.
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

  // One settings read per sweep. Each prune below would otherwise fetch the
  // same singleton row again — eight round-trips for six columns (#442).
  // Passing the windows explicitly is what makes them stop. At `multi` the
  // sweep itself runs once per org (§108), so this read — and the coherence
  // warning under it — repeat per org: the windows are global, so every org
  // reads the same row and any warning says the same thing N times. Hoisting
  // them above the iteration would mean passing them through the job
  // registry, which is a wider seam change than one indexed singleton read an
  // hour is worth.
  const windows = await loadRetentionWindows();

  warnOnIncoherentRetention(windows);

  const webhookResult = await pruneWebhookDeliveries(
    windows.webhookRetentionDays,
    windows.webhookDlqRetentionDays
  );
  const hookResult = await pruneHookDeliveries(windows.webhookRetentionDays);
  const costLogResult = await pruneCostLogs(windows.costLogRetentionDays);
  const executionResult = await pruneExecutions(windows.executionRetentionDays);
  const evaluationResult = await pruneEvaluationData(windows.evaluationRetentionDays);

  return {
    deleted: totalDeleted,
    agentsProcessed: agents.length,
    webhookDeliveriesDeleted: webhookResult.deleted,
    hookDeliveriesDeleted: hookResult.deleted,
    costLogsDeleted: costLogResult.deleted,
    executionsDeleted: executionResult.deleted,
    evaluationSessionsDeleted: evaluationResult.sessionsDeleted,
    evaluationRunsDeleted: evaluationResult.runsDeleted,
  };
}

/**
 * Prune the two system audit tables — the admin audit log per
 * `auditLogRetentionDays`, the MCP audit log per
 * `McpServerConfig.auditRetentionDays`.
 *
 * Neither table carries an org (`SYSTEM_MODELS` in
 * `lib/tenancy/classification.ts`), so this runs once, under the audited
 * system scope, rather than once per org with the tenant sweep.
 *
 * Each prune resolves its own window here, which the tenant sweep's hoisted
 * `loadRetentionWindows()` exists to avoid (#442). It is not the same shape:
 * that was eight prunes re-reading one settings row inside a single sweep;
 * this is one prune reading one column, once an hour, and the column is no
 * longer in the tenant sweep's select.
 */
export async function enforceSystemRetentionPolicies(): Promise<SystemRetentionResult> {
  const auditLogResult = await pruneAuditLogs();
  const mcpAuditResult = await pruneMcpAuditLogs();
  return {
    auditLogsDeleted: auditLogResult.deleted,
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
  maxAgeDays?: number | null,
  dlqMaxAgeDays?: number | null
): Promise<PruneResult> {
  const baseDays =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('webhookRetentionDays');
  const dlqDays =
    (dlqMaxAgeDays !== undefined
      ? dlqMaxAgeDays
      : await resolveRetentionDays('webhookDlqRetentionDays')) ?? baseDays;

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
export async function pruneHookDeliveries(maxAgeDays?: number | null): Promise<PruneResult> {
  const days =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('webhookRetentionDays');
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
export async function pruneCostLogs(maxAgeDays?: number | null): Promise<PruneResult> {
  const days =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('costLogRetentionDays');
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
export async function pruneAuditLogs(maxAgeDays?: number | null): Promise<PruneResult> {
  const days =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('auditLogRetentionDays');
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
export async function pruneExecutions(maxAgeDays?: number | null): Promise<PruneResult> {
  const days =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('executionRetentionDays');
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
export async function pruneEvaluationData(
  maxAgeDays?: number | null
): Promise<EvaluationPruneResult> {
  const days =
    maxAgeDays !== undefined ? maxAgeDays : await resolveRetentionDays('evaluationRetentionDays');
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
  let days: number;
  if (maxAgeDays !== undefined) {
    days = maxAgeDays;
  } else {
    // Mirror resolveRetentionDays' swallow-on-error contract so a transient
    // McpServerConfig read failure skips this prune rather than throwing out
    // of enforceRetentionPolicies (which would mask the prunes that already ran).
    try {
      days = (await getMcpServerConfig()).auditRetentionDays;
    } catch {
      return { deleted: 0 };
    }
  }
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

/**
 * Log once per sweep when cost-log retention is shorter than execution
 * retention.
 *
 * `AiWorkflowExecution.totalCostUsd` is a scalar column, so it outlives the
 * `AiCostLog` rows behind it: prune the logs first and an execution keeps
 * reporting spend while its breakdown reads empty. The settings route rejects
 * the combination at write time, but installs configured before that check
 * existed stay silently in this state — nobody re-saves settings to find out.
 *
 * Reads nothing itself — the sweep's single `loadRetentionWindows()` already has
 * both values, and a failed read arrives here as `null`, which is silence.
 */
function warnOnIncoherentRetention(windows: RetentionWindows): void {
  const costLogDays = windows.costLogRetentionDays;
  const executionDays = windows.executionRetentionDays;
  // Either window unset means that class isn't pruned at all — no coupling.
  if (costLogDays === null || executionDays === null) return;
  if (costLogDays >= executionDays) return;

  logger.warn(
    'Retention windows are incoherent: cost logs are pruned before the executions that reference them, so cost breakdowns will read empty for executions still on file',
    { costLogRetentionDays: costLogDays, executionRetentionDays: executionDays }
  );
}

/**
 * The global retention windows the TENANT sweep needs, in days. `null` = that
 * class is never pruned.
 *
 * `auditLogRetentionDays` is deliberately absent: the admin audit log moved to
 * {@link enforceSystemRetentionPolicies} (§108), so selecting it here would
 * read a column this sweep never uses.
 */
export interface RetentionWindows {
  webhookRetentionDays: number | null;
  webhookDlqRetentionDays: number | null;
  costLogRetentionDays: number | null;
  executionRetentionDays: number | null;
  evaluationRetentionDays: number | null;
}

const NO_RETENTION_WINDOWS: RetentionWindows = {
  webhookRetentionDays: null,
  webhookDlqRetentionDays: null,
  costLogRetentionDays: null,
  executionRetentionDays: null,
  evaluationRetentionDays: null,
};

/**
 * Read all six retention windows in **one** query.
 *
 * `resolveRetentionDays` reads the same singleton row once per prune, which cost
 * a sweep seven or eight round-trips to fetch six columns (#442). This is a
 * hoist, not a cache: every prune already takes an explicit window as its first
 * parameter, the sweep just never passed one.
 *
 * Read failures degrade to "no windows configured", matching
 * `resolveRetentionDays`' swallow-on-error contract — a transient settings-read
 * failure skips the prunes rather than throwing out of the sweep.
 */
export async function loadRetentionWindows(): Promise<RetentionWindows> {
  try {
    const row = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: {
        webhookRetentionDays: true,
        webhookDlqRetentionDays: true,
        costLogRetentionDays: true,
        executionRetentionDays: true,
        evaluationRetentionDays: true,
      },
    });
    if (!row) return NO_RETENTION_WINDOWS;
    return {
      webhookRetentionDays: row.webhookRetentionDays ?? null,
      webhookDlqRetentionDays: row.webhookDlqRetentionDays ?? null,
      costLogRetentionDays: row.costLogRetentionDays ?? null,
      executionRetentionDays: row.executionRetentionDays ?? null,
      evaluationRetentionDays: row.evaluationRetentionDays ?? null,
    };
  } catch {
    return NO_RETENTION_WINDOWS;
  }
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
