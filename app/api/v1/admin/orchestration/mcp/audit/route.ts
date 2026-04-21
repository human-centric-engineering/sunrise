/**
 * Admin MCP — Audit Log
 *
 * GET    /api/v1/admin/orchestration/mcp/audit — query audit logs with filters
 * DELETE /api/v1/admin/orchestration/mcp/audit — purge logs older than retention period
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { queryMcpAuditLogs, getMcpServerConfig } from '@/lib/orchestration/mcp';
import { mcpAuditQuerySchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const filters = validateQueryParams(new URL(request.url).searchParams, mcpAuditQuerySchema);

  const { items, total } = await queryMcpAuditLogs(filters);

  log.info('MCP audit logs queried', { count: items.length, total });
  return paginatedResponse(items as Record<string, unknown>[], {
    page: filters.page,
    limit: filters.limit,
    total,
  });
});

/**
 * Purge audit logs older than the configured retention period.
 * Uses `auditRetentionDays` from McpServerConfig. Returns 0 if retention is disabled (0 days).
 */
export const DELETE = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const config = await getMcpServerConfig();

  if (config.auditRetentionDays === 0) {
    log.info('MCP audit cleanup skipped — retention set to 0 (keep forever)', {
      adminId: session.user.id,
    });
    return successResponse({ deleted: 0, message: 'Retention is set to 0 (keep forever)' });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.auditRetentionDays);

  const result = await prisma.mcpAuditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  log.info('MCP audit logs purged', {
    adminId: session.user.id,
    deleted: result.count,
    retentionDays: config.auditRetentionDays,
    cutoff: cutoff.toISOString(),
  });

  return successResponse({
    deleted: result.count,
    retentionDays: config.auditRetentionDays,
    cutoff: cutoff.toISOString(),
  });
});
