/**
 * Admin Orchestration — Bulk agent operations
 *
 * POST /api/v1/admin/orchestration/agents/bulk
 *   Body: { action: 'activate' | 'deactivate' | 'delete', agentIds: string[] }
 *
 * Applies the chosen action to all specified agents. System agents
 * (`isSystem = true`) are excluded from all mutations. Delete is a
 * soft delete (sets `isActive = false`), matching the single-agent
 * DELETE endpoint behaviour.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { bulkAgentActionSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { action, agentIds } = await validateRequestBody(request, bulkAgentActionSchema);

  const where = {
    id: { in: agentIds },
    isSystem: false, // never mutate system agents
  };

  let affected: number;

  switch (action) {
    case 'activate': {
      const result = await prisma.aiAgent.updateMany({ where, data: { isActive: true } });
      affected = result.count;
      break;
    }
    case 'deactivate':
    case 'delete': {
      // Both soft-delete by setting isActive = false
      const result = await prisma.aiAgent.updateMany({ where, data: { isActive: false } });
      affected = result.count;
      break;
    }
  }

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
