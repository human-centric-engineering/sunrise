/**
 * Admin MCP — Exposed Resources
 *
 * GET  /api/v1/admin/orchestration/mcp/resources — list exposed resources
 * POST /api/v1/admin/orchestration/mcp/resources — create exposed resource
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { Prisma } from '@prisma/client';
import { clearMcpResourceCache, broadcastMcpResourcesChanged } from '@/lib/orchestration/mcp';
import {
  createExposedResourceSchema,
  listExposedResourcesQuerySchema,
} from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { page, limit, isEnabled, resourceType } = validateQueryParams(
    new URL(request.url).searchParams,
    listExposedResourcesQuerySchema
  );

  const where: Record<string, unknown> = {};
  if (isEnabled !== undefined) where.isEnabled = isEnabled;
  if (resourceType) where.resourceType = resourceType;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.mcpExposedResource.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.mcpExposedResource.count({ where }),
  ]);

  log.info('MCP exposed resources listed', { count: items.length, total });
  return paginatedResponse(items, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createExposedResourceSchema);

  const resource = await prisma.mcpExposedResource.create({
    data: {
      uri: body.uri,
      name: body.name,
      description: body.description,
      mimeType: body.mimeType,
      resourceType: body.resourceType,
      isEnabled: body.isEnabled,
      handlerConfig: body.handlerConfig
        ? (body.handlerConfig as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  clearMcpResourceCache();
  broadcastMcpResourcesChanged();

  log.info('MCP exposed resource created', {
    adminId: session.user.id,
    resourceId: resource.id,
    uri: resource.uri,
  });

  return successResponse(resource, undefined, { status: 201 });
});
