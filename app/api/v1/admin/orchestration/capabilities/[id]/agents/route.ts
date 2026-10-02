/**
 * Admin Orchestration — Capability → agents reverse lookup
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/agents
 *   Returns the minimal agent projections for every agent IN THE CALLER'S
 *   ORG that has this capability attached via the `AiAgentCapability`
 *   pivot, and `meta.otherOrgAgentCount`: agents in other orgs with it
 *   attached, counted and never named (§107 t-752). The array keeps its
 *   shape, so a caller that ignores `meta` reads what it always read.
 *
 *   Used by the Capability edit page: its Safety tab's "Used by" card and
 *   the quarantine card's blast radius. The Capabilities list reads the
 *   same usage inline (`_agents`, `_otherOrgAgentCount`).
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
import { cuidSchema } from '@/lib/validations/common';
import { capabilityAgentUsage } from '@/lib/orchestration/admin/global-config-usage';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
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

  const usage = (await capabilityAgentUsage([capabilityId])).get(capabilityId);
  const agents = usage?.agents ?? [];
  const otherOrgAgentCount = usage?.otherOrgAgents ?? 0;
  log.info('Capability agents listed', { capabilityId, count: agents.length, otherOrgAgentCount });
  return successResponse(agents, { otherOrgAgentCount });
});
