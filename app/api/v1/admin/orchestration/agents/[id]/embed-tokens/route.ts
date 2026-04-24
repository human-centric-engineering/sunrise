/**
 * Admin Orchestration — Agent Embed Tokens
 *
 * GET  /api/v1/admin/orchestration/agents/:id/embed-tokens — list tokens
 * POST /api/v1/admin/orchestration/agents/:id/embed-tokens — create token
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { createEmbedTokenSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

type Params = { id: string };

export const GET = withAdminAuth<Params>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  const agentId = parsed.data;
  const log = await getRouteLogger(request);

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');

  const tokens = await prisma.aiAgentEmbedToken.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    include: { creator: { select: { id: true, name: true } } },
  });

  log.info('Embed tokens listed', { agentId, count: tokens.length });
  return successResponse(tokens);
});

export const POST = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  const agentId = parsed.data;
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createEmbedTokenSchema);

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true },
  });
  if (!agent) throw new NotFoundError('Agent not found');

  const token = await prisma.aiAgentEmbedToken.create({
    data: {
      agentId,
      label: body.label ?? null,
      allowedOrigins: body.allowedOrigins,
      createdBy: session.user.id,
    },
    include: { creator: { select: { id: true, name: true } } },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'embed_token.create',
    entityType: 'embed_token',
    entityId: token.id,
    entityName: body.label ?? null,
    metadata: { agentId, agentName: agent.name },
    clientIp: clientIP,
  });

  log.info('Embed token created', { agentId, tokenId: token.id });
  return successResponse(token, undefined, { status: 201 });
});
