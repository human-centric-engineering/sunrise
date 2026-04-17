/**
 * Admin Orchestration — Capability rate limit usage
 *
 * GET /api/v1/admin/orchestration/agents/:id/capabilities/usage
 *
 * Returns the number of capability executions per slug in the last 60
 * seconds for the given agent. Used by the capabilities tab to display
 * live usage against configured rate limits.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

interface UsageRow {
  slug: string;
  count: number;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const agentId = parsed.data;

  const rows = await prisma.$queryRaw<UsageRow[]>`
    SELECT metadata->>'slug' AS slug, COUNT(*)::int AS count
    FROM "AiCostLog"
    WHERE "agentId" = ${agentId}
      AND "operation" = 'tool_call'
      AND "createdAt" >= NOW() - INTERVAL '60 seconds'
    GROUP BY metadata->>'slug'
  `;

  const usage: Record<string, number> = {};
  for (const row of rows) {
    if (row.slug) {
      usage[row.slug] = row.count;
    }
  }

  log.debug('Capability usage fetched', { agentId, slugCount: Object.keys(usage).length });

  return successResponse({ usage });
});
