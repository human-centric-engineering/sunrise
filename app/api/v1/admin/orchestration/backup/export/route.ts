/**
 * Admin Orchestration — Backup Export
 *
 * POST /api/v1/admin/orchestration/backup/export — export orchestration config as JSON
 *
 * Authentication: Admin role required.
 *
 * Query (§109 t-738): `orgId` — the org to back up, defaulting to the active
 * org (an unbound admin API key must name one at `multi`); `shared` — whether
 * to include capabilities, knowledge tags and the orchestration settings,
 * refused for any org but the install org. See `resolveBackupScope()`.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';
import { backupScopeQuerySchema, resolveBackupScope } from '@/lib/orchestration/backup/scope';
import { validateQueryParams } from '@/lib/api/validation';

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const query = validateQueryParams(new URL(request.url).searchParams, backupScopeQuerySchema);
  const scope = await resolveBackupScope(query, session.principal, 'export');
  const payload = await exportOrchestrationConfig(scope);

  logAdminAction({
    userId: session.user.id,
    action: 'backup.export',
    entityType: 'backup',
    // The org the backup is of; `includesShared` says whether the shared part moved too.
    entityId: scope.orgId,
    metadata: {
      orgId: scope.orgId,
      includesShared: scope.includeShared,
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
    orgId: scope.orgId,
    includesShared: scope.includeShared,
    agents: payload.data.agents.length,
    capabilities: payload.data.capabilities.length,
    workflows: payload.data.workflows.length,
  });

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="orchestration-backup-${scope.orgId}-${payload.exportedAt.replace(/[:.]/g, '-')}.json"`,
    },
  });
});
