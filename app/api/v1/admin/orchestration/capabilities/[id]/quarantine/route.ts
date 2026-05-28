/**
 * Admin Orchestration — Quarantine a capability (item #42)
 *
 * POST /api/v1/admin/orchestration/capabilities/:id/quarantine
 *
 * Puts a capability into soft or hard quarantine. Distinct from
 * `PATCH .../[id]` (routine edits / isActive toggle) so the audit log
 * cleanly separates incident-response actions from routine ones.
 *
 * - Soft mode: dispatcher returns a structured `capability_quarantined`
 *   error so the agent can route around the tool via plan / orchestrator.
 * - Hard mode: dispatcher refuses dispatch and sets `skipFollowup` so
 *   the model's tool loop terminates.
 *
 * Unlike PATCH's `isActive=false`, quarantine is intentionally allowed on
 * system capabilities — the whole point is emergency response, not routine
 * deactivation.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import { quarantineCapabilitySchema } from '@/lib/validations/orchestration';
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

  const body = await validateRequestBody(request, quarantineCapabilitySchema);

  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw new ValidationError('Quarantine expiry must be in the future', {
      expiresAt: ['Must be a future timestamp'],
    });
  }

  const updated = await prisma.aiCapability.update({
    where: { id },
    data: {
      quarantineState: body.mode,
      quarantineReason: body.reason,
      quarantineUntil: expiresAt,
    },
  });

  // Dispatcher caches registry entries for 5 minutes — drop the cache so
  // the new state takes effect on the next call from any agent.
  capabilityDispatcher.clearCache();

  log.info('Capability quarantined', {
    capabilityId: id,
    slug: updated.slug,
    mode: body.mode,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'capability.quarantine',
    entityType: 'capability',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(current, updated),
    metadata: { mode: body.mode, reason: body.reason, expiresAt: expiresAt?.toISOString() ?? null },
    clientIp: clientIP,
  });

  emitHookEvent('capability.quarantined', {
    capabilityId: id,
    capabilitySlug: updated.slug,
    capabilityName: updated.name,
    mode: body.mode,
    reason: body.reason,
    expiresAt: expiresAt?.toISOString() ?? null,
    actorUserId: session.user.id,
    at: new Date().toISOString(),
  });

  return successResponse(updated);
});
