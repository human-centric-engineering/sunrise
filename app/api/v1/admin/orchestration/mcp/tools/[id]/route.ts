/**
 * Admin MCP — Exposed Tool by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/tools/:id — update exposed tool
 * DELETE /api/v1/admin/orchestration/mcp/tools/:id — remove exposed tool
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { clearMcpToolCache, broadcastMcpToolsChanged } from '@/lib/orchestration/mcp';
import { updateExposedToolSchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateExposedToolSchema);

  const existing = await prisma.mcpExposedTool.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Exposed tool not found');

  const updated = await prisma.mcpExposedTool.update({
    where: { id },
    data: body,
    include: { capability: true },
  });

  clearMcpToolCache();
  broadcastMcpToolsChanged();

  log.info('MCP exposed tool updated', {
    adminId: session.user.id,
    toolId: id,
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

  const existing = await prisma.mcpExposedTool.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Exposed tool not found');

  await prisma.mcpExposedTool.delete({ where: { id } });
  clearMcpToolCache();
  broadcastMcpToolsChanged();

  log.info('MCP exposed tool deleted', {
    adminId: session.user.id,
    toolId: id,
  });

  return successResponse({ id, deleted: true });
});
