/**
 * Admin MCP — Exposed Tools
 *
 * GET  /api/v1/admin/orchestration/mcp/tools — list exposed tools
 * POST /api/v1/admin/orchestration/mcp/tools — create exposed tool
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { clearMcpToolCache, broadcastMcpToolsChanged } from '@/lib/orchestration/mcp';
import { createExposedToolSchema, listExposedToolsQuerySchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { page, limit, isEnabled } = validateQueryParams(
    new URL(request.url).searchParams,
    listExposedToolsQuerySchema
  );

  const where: Record<string, unknown> = {};
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.mcpExposedTool.findMany({
      where,
      skip,
      take: limit,
      orderBy: { capability: { name: 'asc' } },
      include: { capability: true },
    }),
    prisma.mcpExposedTool.count({ where }),
  ]);

  log.info('MCP exposed tools listed', { count: items.length, total });
  return paginatedResponse(items, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createExposedToolSchema);

  const tool = await prisma.mcpExposedTool.create({
    data: {
      capabilityId: body.capabilityId,
      isEnabled: body.isEnabled,
      customName: body.customName ?? null,
      customDescription: body.customDescription ?? null,
      rateLimitPerKey: body.rateLimitPerKey ?? null,
      requiresScope: body.requiresScope ?? null,
    },
    include: { capability: true },
  });

  clearMcpToolCache();
  broadcastMcpToolsChanged();

  log.info('MCP exposed tool created', {
    adminId: session.user.id,
    toolId: tool.id,
    capabilitySlug: tool.capability.slug,
    isEnabled: tool.isEnabled,
  });

  return successResponse(tool, undefined, { status: 201 });
});
