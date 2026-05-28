/**
 * Admin Orchestration — Quarantined capabilities for an agent (item #42)
 *
 * GET /api/v1/admin/orchestration/agents/:id/quarantined-capabilities
 *
 * Returns every capability the agent currently binds that is in
 * effective quarantine (auto-expiry honoured via the shared
 * `resolveQuarantineState`). Powers the per-agent banner on the agent
 * detail page.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { resolveQuarantineState } from '@/lib/orchestration/capabilities/dispatcher';

export interface QuarantinedCapabilityForAgent {
  capabilityId: string;
  capabilitySlug: string;
  capabilityName: string;
  mode: 'quarantined-soft' | 'quarantined-hard';
  reason: string | null;
  /** ISO 8601 timestamp; null = indefinite. */
  expiresAt: string | null;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const agentId = parsed.data;

  // Confirm the agent exists so we return a clean 404 rather than an
  // empty list for a typo'd id.
  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);

  const bindings = await prisma.aiAgentCapability.findMany({
    where: {
      agentId,
      isEnabled: true,
      capability: { quarantineState: { not: 'active' } },
    },
    include: {
      capability: {
        select: {
          id: true,
          slug: true,
          name: true,
          quarantineState: true,
          quarantineReason: true,
          quarantineUntil: true,
        },
      },
    },
  });

  const items: QuarantinedCapabilityForAgent[] = [];
  for (const b of bindings) {
    const effective = resolveQuarantineState({
      quarantineState:
        (b.capability.quarantineState as 'active' | 'quarantined-soft' | 'quarantined-hard') ??
        'active',
      quarantineUntil: b.capability.quarantineUntil,
    });
    if (effective === 'active') continue;
    items.push({
      capabilityId: b.capability.id,
      capabilitySlug: b.capability.slug,
      capabilityName: b.capability.name,
      mode: effective,
      reason: b.capability.quarantineReason,
      expiresAt: b.capability.quarantineUntil ? b.capability.quarantineUntil.toISOString() : null,
    });
  }

  log.info('Agent quarantined-capabilities fetched', { agentId, count: items.length });
  return successResponse({ items });
});
