/**
 * Admin Orchestration — Capability → agents reverse lookup
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/agents
 *   Returns the minimal agent projections for every agent that has
 *   this capability attached via the `AiAgentCapability` pivot.
 *
 *   Used by the admin Capabilities list (for the "agents using it"
 *   count) and the Capability edit page (to warn before delete).
 *
 * Mirrors the additive `/agents/:id/capabilities` exception we took
 * in Session 4.2 — Phase 3 is otherwise locked; we only add
 * consumer-side list endpoints where the table/form needs them.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid capability id', { id: ['Must be a valid CUID'] });
  }
  const capabilityId = parsed.data;

  const capability = await prisma.aiCapability.findUnique({
    where: { id: capabilityId },
    select: { id: true },
  });
  if (!capability) throw new NotFoundError(`Capability ${capabilityId} not found`);

  const links = await prisma.aiAgentCapability.findMany({
    where: { capabilityId },
    include: {
      agent: { select: { id: true, name: true, slug: true, isActive: true } },
    },
    orderBy: { agent: { name: 'asc' } },
  });

  const agents = links.map((l) => l.agent);
  log.info('Capability agents listed', { capabilityId, count: agents.length });
  return successResponse(agents);
});
