/**
 * Admin Orchestration — Single Embed Token
 *
 * PATCH  /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId — toggle active, update label/origins
 * DELETE /api/v1/admin/orchestration/agents/:id/embed-tokens/:tokenId — delete token
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

const updateEmbedTokenSchema = z
  .object({
    label: z.string().max(100).nullable().optional(),
    allowedOrigins: z.array(z.string().url().max(500)).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.allowedOrigins !== undefined || v.isActive !== undefined,
    { message: 'At least one field must be provided' }
  );

type Params = { id: string; tokenId: string };

async function findToken(agentId: string, tokenId: string) {
  return prisma.aiAgentEmbedToken.findFirst({
    where: { id: tokenId, agentId },
  });
}

export const PATCH = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: agentId, tokenId } = await params;
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateEmbedTokenSchema);

  const existing = await findToken(agentId, tokenId);
  if (!existing) throw new NotFoundError('Embed token not found');

  const updated = await prisma.aiAgentEmbedToken.update({
    where: { id: tokenId },
    data: {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.allowedOrigins !== undefined ? { allowedOrigins: body.allowedOrigins } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'embed_token.update',
    entityType: 'embed_token',
    entityId: tokenId,
    entityName: updated.label,
    metadata: { agentId, changedKeys: Object.keys(body) },
    clientIp: clientIP,
  });

  log.info('Embed token updated', { agentId, tokenId, changedKeys: Object.keys(body) });
  return successResponse(updated);
});

export const DELETE = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: agentId, tokenId } = await params;
  const log = await getRouteLogger(request);

  const existing = await findToken(agentId, tokenId);
  if (!existing) throw new NotFoundError('Embed token not found');

  await prisma.aiAgentEmbedToken.delete({ where: { id: tokenId } });

  logAdminAction({
    userId: session.user.id,
    action: 'embed_token.delete',
    entityType: 'embed_token',
    entityId: tokenId,
    entityName: existing.label,
    metadata: { agentId },
    clientIp: clientIP,
  });

  log.info('Embed token deleted', { agentId, tokenId });
  return successResponse({ deleted: true });
});
