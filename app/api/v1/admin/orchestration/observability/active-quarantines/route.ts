/**
 * Admin Orchestration — Active capability quarantines (item #42)
 *
 * GET /api/v1/admin/orchestration/observability/active-quarantines
 *
 * Returns every capability that is currently in effective quarantine
 * (auto-expiry honoured via the shared `resolveQuarantineState`).
 * Powers the dashboard's "Active quarantines" panel.
 *
 * Lives under `/observability/` alongside the dashboard-stats route
 * since this is an operational-status read, not a per-capability one.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { resolveQuarantineState } from '@/lib/orchestration/capabilities/dispatcher';

export interface ActiveQuarantineRow {
  id: string;
  slug: string;
  name: string;
  mode: 'quarantined-soft' | 'quarantined-hard';
  reason: string | null;
  /** ISO 8601 timestamp; null for indefinite. */
  expiresAt: string | null;
}

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const rows = await prisma.aiCapability.findMany({
    where: { quarantineState: { not: 'active' } },
    select: {
      id: true,
      slug: true,
      name: true,
      quarantineState: true,
      quarantineReason: true,
      quarantineUntil: true,
    },
  });

  const items: ActiveQuarantineRow[] = [];
  for (const r of rows) {
    // resolveQuarantineState accepts the raw `string` column directly —
    // unknown values fall open to 'active' via the internal guard.
    const effective = resolveQuarantineState({
      quarantineState: r.quarantineState,
      quarantineUntil: r.quarantineUntil,
    });
    if (effective === 'active') continue;
    items.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      mode: effective,
      reason: r.quarantineReason,
      expiresAt: r.quarantineUntil ? r.quarantineUntil.toISOString() : null,
    });
  }

  log.info('Active quarantines fetched', { count: items.length });
  return successResponse({ items });
});
