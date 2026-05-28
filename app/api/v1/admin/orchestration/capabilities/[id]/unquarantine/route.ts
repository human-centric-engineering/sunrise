/**
 * Admin Orchestration — Lift a capability quarantine (item #42)
 *
 * POST /api/v1/admin/orchestration/capabilities/:id/unquarantine
 *
 * Clears all three quarantine fields and restores normal dispatch. Safe
 * to call on a capability that's already active (idempotent — no-op
 * update, no hook fired).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';

function parseCapabilityId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid capability id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseCapabilityId(rawId);

  const current = await prisma.aiCapability.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Capability ${id} not found`);

  // Idempotent: if already active, return current state without writing
  // a no-op audit row or firing a spurious hook.
  if (current.quarantineState === 'active') {
    return successResponse(current);
  }

  const updated = await prisma.aiCapability.update({
    where: { id },
    data: {
      quarantineState: 'active',
      quarantineReason: null,
      quarantineUntil: null,
    },
  });

  capabilityDispatcher.clearCache();

  log.info('Capability unquarantined', {
    capabilityId: id,
    slug: updated.slug,
    previousMode: current.quarantineState,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'capability.unquarantine',
    entityType: 'capability',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(current, updated),
    metadata: { previousMode: current.quarantineState },
    clientIp: clientIP,
  });

  emitHookEvent('capability.unquarantined', {
    capabilityId: id,
    capabilitySlug: updated.slug,
    capabilityName: updated.name,
    previousMode: current.quarantineState,
    actorUserId: session.user.id,
    at: new Date().toISOString(),
  });

  return successResponse(updated);
});
