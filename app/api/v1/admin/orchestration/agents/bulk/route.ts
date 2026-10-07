/**
 * Admin Orchestration — Bulk agent operations
 *
 * POST /api/v1/admin/orchestration/agents/bulk
 *   Body: { action: 'activate' | 'deactivate' | 'delete', agentIds: string[] }
 *
 * Applies the chosen action to all specified agents. System agents
 * (`isSystem = true`) are excluded from all mutations. Delete is a
 * soft delete (sets `isActive = false`), matching the single-agent
 * DELETE endpoint behaviour. Each agent the action changes gets a new
 * agent version, as any change to versioned config does.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { bulkAgentActionSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { ConflictError } from '@/lib/api/errors';
import {
  AGENT_BATCH_TRANSACTION_TIMEOUT_MS,
  ensureBaselineVersion,
  isAgentVersionConflict,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';

const BULK_VERSION_LABELS = {
  activate: 'Bulk activate',
  deactivate: 'Bulk deactivate',
  delete: 'Bulk delete',
} as const;

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { action, agentIds } = await validateRequestBody(request, bulkAgentActionSchema);

  const where = {
    id: { in: agentIds },
    isSystem: false, // never mutate system agents
  };

  // `isActive` is a versioned field, so each agent the action changes gets a
  // new version in the same transaction, keeping its newest version equal to
  // its live config.
  const isActive = action === 'activate';
  const label = BULK_VERSION_LABELS[action];
  const affected = await prisma
    .$transaction(
      async (tx) => {
        // Only the agents this action changes need a version; one already in
        // the requested state is left alone by the write too.
        const targets = await tx.aiAgent.findMany({
          where: { ...where, isActive: !isActive },
          select: { id: true },
        });
        for (const { id } of targets) {
          await ensureBaselineVersion(tx, id, session.user.id);
        }
        // Delete is a soft delete, so it sets isActive = false like deactivate.
        // Exactly the agents selected above: a wider `where` could also catch
        // one a concurrent edit flipped meanwhile, which would get no version.
        const result = await tx.aiAgent.updateMany({
          where: { id: { in: targets.map((t) => t.id) } },
          data: { isActive },
        });
        for (const { id } of targets) {
          await recordAgentVersion(tx, id, { label, createdBy: session.user.id });
        }
        return result.count;
      },
      { timeout: AGENT_BATCH_TRANSACTION_TIMEOUT_MS }
    )
    .catch((err: unknown) => {
      // A concurrent edit to one of these agents took a version number. The
      // transaction rolled back, so the action can be retried.
      if (isAgentVersionConflict(err)) {
        throw new ConflictError('Bulk action conflicted with a concurrent change. Please retry.');
      }
      throw err;
    });

  log.info('Bulk agent action', {
    action,
    requested: agentIds.length,
    affected,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: `agent.bulk.${action}`,
    entityType: 'agent',
    entityName: `Bulk ${action} (${affected}/${agentIds.length})`,
    metadata: { action, requested: agentIds.length, affected, agentIds },
    clientIp: clientIP,
  });

  return successResponse({ action, requested: agentIds.length, affected });
});
