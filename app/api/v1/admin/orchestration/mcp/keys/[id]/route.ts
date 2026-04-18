/**
 * Admin MCP — API Key by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/keys/:id — update (revoke, rename, change expiry)
 * DELETE /api/v1/admin/orchestration/mcp/keys/:id — permanently delete key
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { updateApiKeySchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateApiKeySchema);

  const existing = await prisma.mcpApiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('API key not found');

  const updated = await prisma.mcpApiKey.update({
    where: { id },
    data: body,
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      isActive: true,
      expiresAt: true,
      lastUsedAt: true,
      rateLimitOverride: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  log.info('MCP API key updated', {
    adminId: session.user.id,
    keyId: id,
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

  const existing = await prisma.mcpApiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('API key not found');

  await prisma.mcpApiKey.delete({ where: { id } });

  log.info('MCP API key deleted', {
    adminId: session.user.id,
    keyId: id,
    keyPrefix: existing.keyPrefix,
  });

  return successResponse({ id, deleted: true });
});
