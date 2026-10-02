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
import { NotFoundError } from '@/lib/api/errors';
import { validatePathParam } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { resolveQuarantineState } from '@/lib/orchestration/capabilities/dispatcher';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'capability id' });

    const current = await prisma.aiCapability.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`Capability ${id} not found`);

    // Idempotent on *effective* state: a row whose `quarantineUntil` has
    // already passed is treated as active by the dispatcher and every
    // read path, so lifting it must not fire a hook or write an audit
    // row either (the `hooks/types.ts` comment on `capability.unquarantined`
    // is explicit: "Auto-expiry (read-time) does NOT fire an unquarantined
    // event"). We still leave the stored quarantineUntil intact — the
    // field is preserved for audit reconstruction.
    const effective = resolveQuarantineState({
      quarantineState: current.quarantineState,
      quarantineUntil: current.quarantineUntil,
    });
    if (effective === 'active') {
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
  },
  { writesSharedSettings: true }
);
