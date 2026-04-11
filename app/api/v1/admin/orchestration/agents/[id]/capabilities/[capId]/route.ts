/**
 * Admin Orchestration — Detach / update agent↔capability link
 *
 * DELETE /api/v1/admin/orchestration/agents/:id/capabilities/:capId
 *   Removes the pivot row. `capId` is the **`AiCapability.id`**, not
 *   the pivot row id — matches the attach flow.
 * PATCH  /api/v1/admin/orchestration/agents/:id/capabilities/:capId
 *   Body: { isEnabled?, customConfig?, customRateLimit? }
 *   Updates the pivot row in place.
 *
 * Both paths call `capabilityDispatcher.clearCache()` on success.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { updateAgentCapabilitySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

type RouteParams = { id: string; capId: string };

function parseIds(raw: RouteParams): { agentId: string; capabilityId: string } {
  const agentIdParse = cuidSchema.safeParse(raw.id);
  const capIdParse = cuidSchema.safeParse(raw.capId);
  const fieldErrors: Record<string, string[]> = {};
  if (!agentIdParse.success) fieldErrors.id = ['Must be a valid CUID'];
  if (!capIdParse.success) fieldErrors.capId = ['Must be a valid CUID'];
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError('Invalid route parameters', fieldErrors);
  }
  return { agentId: agentIdParse.data as string, capabilityId: capIdParse.data as string };
}

export const PATCH = withAdminAuth<RouteParams>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { agentId, capabilityId } = parseIds(await params);

  const body = await validateRequestBody(request, updateAgentCapabilitySchema);

  const data: Prisma.AiAgentCapabilityUpdateInput = {};
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
  if (body.customConfig !== undefined) {
    data.customConfig = body.customConfig as Prisma.InputJsonValue;
  }
  if (body.customRateLimit !== undefined) data.customRateLimit = body.customRateLimit;

  try {
    const link = await prisma.aiAgentCapability.update({
      where: { agentId_capabilityId: { agentId, capabilityId } },
      data,
    });

    capabilityDispatcher.clearCache();

    log.info('Agent↔capability link updated', {
      agentId,
      capabilityId,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    return successResponse(link);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError(`Capability ${capabilityId} is not attached to agent ${agentId}`);
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<RouteParams>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { agentId, capabilityId } = parseIds(await params);

  try {
    await prisma.aiAgentCapability.delete({
      where: { agentId_capabilityId: { agentId, capabilityId } },
    });

    capabilityDispatcher.clearCache();

    log.info('Capability detached from agent', {
      agentId,
      capabilityId,
      adminId: session.user.id,
    });

    return successResponse({ agentId, capabilityId, detached: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError(`Capability ${capabilityId} is not attached to agent ${agentId}`);
    }
    throw err;
  }
});
