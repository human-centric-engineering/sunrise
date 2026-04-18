/**
 * Admin MCP — Exposed Resource by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/resources/:id — update
 * DELETE /api/v1/admin/orchestration/mcp/resources/:id — delete
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { Prisma } from '@prisma/client';
import { clearMcpResourceCache, broadcastMcpResourcesChanged } from '@/lib/orchestration/mcp';
import { updateExposedResourceSchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateExposedResourceSchema);

  const existing = await prisma.mcpExposedResource.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Exposed resource not found');

  const { handlerConfig, ...rest } = body;
  const data: Record<string, unknown> = { ...rest };
  if (handlerConfig !== undefined) {
    data.handlerConfig = handlerConfig === null ? Prisma.JsonNull : handlerConfig;
  }

  const updated = await prisma.mcpExposedResource.update({
    where: { id },
    data,
  });

  clearMcpResourceCache();
  broadcastMcpResourcesChanged();

  log.info('MCP exposed resource updated', {
    adminId: session.user.id,
    resourceId: id,
    changedKeys: Object.keys(body),
  });

  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const existing = await prisma.mcpExposedResource.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Exposed resource not found');

  await prisma.mcpExposedResource.delete({ where: { id } });
  clearMcpResourceCache();
  broadcastMcpResourcesChanged();

  log.info('MCP exposed resource deleted', {
    adminId: session.user.id,
    resourceId: id,
  });

  return successResponse({ id, deleted: true });
});
