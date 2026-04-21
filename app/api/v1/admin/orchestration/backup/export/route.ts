/**
 * Admin Orchestration — Backup Export
 *
 * POST /api/v1/admin/orchestration/backup/export — export orchestration config as JSON
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const payload = await exportOrchestrationConfig();

  logAdminAction({
    userId: session.user.id,
    action: 'backup.export',
    entityType: 'backup',
    entityId: 'full',
    metadata: {
      agents: payload.data.agents.length,
      capabilities: payload.data.capabilities.length,
      workflows: payload.data.workflows.length,
      webhooks: payload.data.webhooks.length,
      hasSettings: payload.data.settings !== null,
    },
    clientIp: clientIP,
  });

  log.info('Orchestration config exported', {
    adminId: session.user.id,
    agents: payload.data.agents.length,
    capabilities: payload.data.capabilities.length,
    workflows: payload.data.workflows.length,
  });

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="orchestration-backup-${payload.exportedAt.replace(/[:.]/g, '-')}.json"`,
    },
  });
});
