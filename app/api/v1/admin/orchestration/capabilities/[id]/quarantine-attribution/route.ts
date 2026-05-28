/**
 * Admin Orchestration — Quarantine audit attribution for a capability (item #42)
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/quarantine-attribution
 *
 * Returns the most recent `capability.quarantine` audit row for this
 * capability, joined to the actor user. Powers the "Quarantined N ago
 * by X" line on the QuarantineCard.
 *
 * Returns `{ attribution: null }` when the capability is currently
 * `active` (no point reading the audit row) or when no quarantine row
 * exists yet. Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

export interface QuarantineAttribution {
  /** ISO 8601 timestamp of the most recent quarantine write. */
  at: string;
  /** Actor name; falls back to email; null when the user row is gone. */
  actorName: string | null;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid capability id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const cap = await prisma.aiCapability.findUnique({
    where: { id },
    select: { id: true, quarantineState: true },
  });
  if (!cap) throw new NotFoundError(`Capability ${id} not found`);

  // Active state: don't query the audit log. Returning `null` here keeps
  // the contract uniform — callers always read `data.attribution`.
  if (cap.quarantineState === 'active') {
    return successResponse({ attribution: null as QuarantineAttribution | null });
  }

  const row = await prisma.aiAdminAuditLog.findFirst({
    where: {
      entityType: 'capability',
      entityId: id,
      action: 'capability.quarantine',
    },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, email: true } } },
  });

  const attribution: QuarantineAttribution | null = row
    ? {
        at: row.createdAt.toISOString(),
        actorName: row.user?.name ?? row.user?.email ?? null,
      }
    : null;

  log.info('Capability quarantine attribution fetched', {
    capabilityId: id,
    hasAttribution: attribution !== null,
  });
  return successResponse({ attribution });
});
