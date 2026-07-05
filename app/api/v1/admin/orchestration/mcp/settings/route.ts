/**
 * Admin MCP — Settings singleton
 *
 * GET   /api/v1/admin/orchestration/mcp/settings — read MCP server config
 * PATCH /api/v1/admin/orchestration/mcp/settings — partial update
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { getMcpServerConfig, invalidateMcpConfigCache } from '@/lib/orchestration/mcp';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';
import { updateMcpSettingsSchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const config = await getMcpServerConfig();

  log.info('MCP settings fetched', { isEnabled: config.isEnabled });
  return successResponse(config);
});

export const PATCH = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateMcpSettingsSchema);

  const existing = await prisma.mcpServerConfig.findUnique({ where: { slug: 'global' } });

  const row = await prisma.mcpServerConfig.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      isEnabled: false,
      serverName: 'Sunrise MCP Server',
      // serverVersion tracks SUNRISE_VERSION — see lib/orchestration/mcp/config.ts
      // for the rationale (Sunrise IS the MCP server implementation here).
      serverVersion: SUNRISE_VERSION,
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
      ...body,
    },
    update: body,
  });

  invalidateMcpConfigCache();

  logAdminAction({
    userId: session.user.id,
    action: 'mcp_settings.update',
    entityType: 'mcp_settings',
    entityId: 'global',
    changes: computeChanges(existing ?? {}, row, { ignoreKeys: ['updatedAt', 'createdAt'] }),
    metadata: { changedKeys: Object.keys(body) },
    clientIp: clientIP,
  });

  log.info('MCP settings updated', {
    adminId: session.user.id,
    changedKeys: Object.keys(body),
    isEnabled: row.isEnabled,
  });

  return successResponse(row);
});
