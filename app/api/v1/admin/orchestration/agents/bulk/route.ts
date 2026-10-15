/**
 * Admin Orchestration — Bulk agent operations
 *
 * POST /api/v1/admin/orchestration/agents/bulk
 *   Body: { action: 'activate' | 'deactivate' | 'delete', agentIds: string[] }
 *
 * Applies the chosen action to all specified agents. System agents
 * (`isSystem = true`) and agents already deleted through
 * `DELETE /agents/:id` (`deletedAt` set) are excluded from all mutations;
 * their ids come back in `skipped`, alongside any id that matches no
 * agent. Delete is a
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

/** A selected agent was deleted before the write reached it. */
class BulkTargetsChangedError extends Error {}

export const POST = withAdminAuth(
  async (request, session) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { action, agentIds } = await validateRequestBody(request, bulkAgentActionSchema);

    const where = {
      id: { in: agentIds },
      isSystem: false, // never mutate system agents
      deletedAt: null, // nor revive or version a deleted one
    };

    // `isActive` is a versioned field, so each agent the action changes gets a
    // new version in the same transaction, keeping its newest version equal to
    // its live config.
    const isActive = action === 'activate';
    const label = BULK_VERSION_LABELS[action];
    const { affected, skipped } = await prisma
      .$transaction(
        async (tx) => {
          const eligible = await tx.aiAgent.findMany({
            where,
            select: { id: true, isActive: true },
          });
          const eligibleIds = new Set(eligible.map((a) => a.id));
          // Only the agents this action changes need a version; one already in
          // the requested state is left alone by the write too.
          const targets = eligible.filter((a) => a.isActive !== isActive);
          for (const { id } of targets) {
            await ensureBaselineVersion(tx, id, session.user.id);
          }
          // Delete is a soft delete, so it sets isActive = false like deactivate.
          // Exactly the agents selected above: a wider `where` could also catch
          // one a concurrent edit flipped meanwhile, which would get no version.
          // `deletedAt: null` is re-checked here because a DELETE committing
          // after the read above would otherwise be revived by this write.
          const targetIds = targets.map((t) => t.id);
          const result = await tx.aiAgent.updateMany({
            where: { id: { in: targetIds }, deletedAt: null },
            data: { isActive },
          });
          if (result.count !== targetIds.length) {
            // Roll back rather than version an agent the write did not change.
            throw new BulkTargetsChangedError();
          }
          for (const { id } of targets) {
            await recordAgentVersion(tx, id, { label, createdBy: session.user.id });
          }
          return {
            affected: result.count,
            skipped: [...new Set(agentIds)].filter((id) => !eligibleIds.has(id)),
          };
        },
        { timeout: AGENT_BATCH_TRANSACTION_TIMEOUT_MS }
      )
      .catch((err: unknown) => {
        // A concurrent edit to one of these agents took a version number, or
        // deleted one after it was selected. The transaction rolled back, so
        // the action can be retried.
        if (isAgentVersionConflict(err) || err instanceof BulkTargetsChangedError) {
          throw new ConflictError('Bulk action conflicted with a concurrent change. Please retry.');
        }
        throw err;
      });

    log.info('Bulk agent action', {
      action,
      requested: agentIds.length,
      affected,
      skipped: skipped.length,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: `agent.bulk.${action}`,
      entityType: 'agent',
      entityName: `Bulk ${action} (${affected}/${agentIds.length})`,
      metadata: { action, requested: agentIds.length, affected, skipped, agentIds },
      clientIp: clientIP,
    });

    return successResponse({ action, requested: agentIds.length, affected, skipped });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Agents and what hangs off them (capabilities, tokens, versions, widget config) are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
