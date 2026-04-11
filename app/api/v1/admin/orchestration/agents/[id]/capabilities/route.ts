/**
 * Admin Orchestration — Agent ↔ capability pivot list / attach
 *
 * GET    /api/v1/admin/orchestration/agents/:id/capabilities
 *   Returns every `AiAgentCapability` row for the agent with the related
 *   capability included. Used by the admin Agent edit page's Capabilities
 *   tab to render the "Attached" column.
 *
 * POST   /api/v1/admin/orchestration/agents/:id/capabilities
 *   Body: { capabilityId, isEnabled?, customConfig?, customRateLimit? }
 *   Creates an `AiAgentCapability` pivot row linking the agent to the
 *   capability. Calls `capabilityDispatcher.clearCache()` on success so
 *   the dispatcher re-reads bindings on the next call.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { attachAgentCapabilitySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseAgentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawAgentId } = await params;
  const agentId = parseAgentId(rawAgentId);

  const agent = await prisma.aiAgent.findUnique({ where: { id: agentId } });
  if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

  const links = await prisma.aiAgentCapability.findMany({
    where: { agentId },
    include: { capability: true },
    orderBy: { capability: { name: 'asc' } },
  });

  log.info('Agent capabilities listed', { agentId, count: links.length });
  return successResponse(links);
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawAgentId } = await params;
  const agentId = parseAgentId(rawAgentId);

  const agent = await prisma.aiAgent.findUnique({ where: { id: agentId } });
  if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

  const body = await validateRequestBody(request, attachAgentCapabilitySchema);

  const capability = await prisma.aiCapability.findUnique({ where: { id: body.capabilityId } });
  if (!capability) throw new NotFoundError(`Capability ${body.capabilityId} not found`);

  try {
    const link = await prisma.aiAgentCapability.create({
      data: {
        agentId,
        capabilityId: body.capabilityId,
        isEnabled: body.isEnabled,
        customConfig: (body.customConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        customRateLimit: body.customRateLimit ?? null,
      },
    });

    capabilityDispatcher.clearCache();

    log.info('Capability attached to agent', {
      agentId,
      capabilityId: body.capabilityId,
      linkId: link.id,
      adminId: session.user.id,
    });

    return successResponse(link, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(
        `Capability ${body.capabilityId} is already attached to agent ${agentId}`
      );
    }
    throw err;
  }
});
