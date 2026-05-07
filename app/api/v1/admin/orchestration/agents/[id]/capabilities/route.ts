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
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { findUnsetEnvVarReferences } from '@/lib/orchestration/env-template';
import { attachAgentCapabilitySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/**
 * Narrow shape used by `collectMissingEnvVars` to extract the only two
 * fields it scans. The route-layer `customConfig` is `z.record(z.string(),
 * z.unknown())` (capability-specific shape is enforced at execute time),
 * so we validate just the binding-scan-relevant fields here. Malformed
 * values fall through to `safeParse` failure → empty result, which is
 * the right behaviour for a soft warning helper.
 */
const bindingScanSchema = z
  .object({
    forcedUrl: z.string().optional(),
    forcedHeaders: z.record(z.string(), z.string()).optional(),
  })
  .partial();

/**
 * Scans a customConfig blob for `${env:VAR}` references in known
 * credential-bearing fields and returns the names that are NOT set in
 * the running process. Soft warning surfaced to the admin UI — save
 * still succeeds; an admin may legitimately save a binding before the
 * matching env var has been deployed to the host.
 */
function collectMissingEnvVars(customConfig: unknown): string[] {
  const parsed = bindingScanSchema.safeParse(customConfig);
  if (!parsed.success) return [];
  return findUnsetEnvVarReferences(parsed.data.forcedUrl, parsed.data.forcedHeaders);
}

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

    logAdminAction({
      userId: session.user.id,
      action: 'agent.capability_attach',
      entityType: 'agent',
      entityId: agentId,
      entityName: agent.name,
      metadata: { capabilityId: body.capabilityId, capabilitySlug: capability.slug },
      clientIp: clientIP,
    });

    const missingEnvVars = collectMissingEnvVars(body.customConfig);
    const meta = missingEnvVars.length > 0 ? { warnings: { missingEnvVars } } : undefined;
    return successResponse(link, meta, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(
        `Capability ${body.capabilityId} is already attached to agent ${agentId}`
      );
    }
    throw err;
  }
});
