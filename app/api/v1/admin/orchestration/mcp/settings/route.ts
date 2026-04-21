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
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getMcpServerConfig, invalidateMcpConfigCache } from '@/lib/orchestration/mcp';
import { updateMcpSettingsSchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const config = await getMcpServerConfig();

  log.info('MCP settings fetched', { isEnabled: config.isEnabled });
  return successResponse(config);
});

export const PATCH = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateMcpSettingsSchema);

  const row = await prisma.mcpServerConfig.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      isEnabled: false,
      serverName: 'Sunrise MCP Server',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
      ...body,
    },
    update: body,
  });

  invalidateMcpConfigCache();

  log.info('MCP settings updated', {
    adminId: session.user.id,
    changedKeys: Object.keys(body),
    isEnabled: row.isEnabled,
  });

  return successResponse(row);
});
