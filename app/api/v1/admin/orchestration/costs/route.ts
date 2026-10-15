/**
 * Admin Orchestration — Cost breakdown
 *
 * GET /api/v1/admin/orchestration/costs
 *
 * Admin-global observability over `AiCostLog`. Not scoped to the
 * caller's own rows — cost logs have no user relation; every admin
 * sees the same totals. Matches the knowledge-base design.
 *
 * Query params (validated by `costBreakdownQuerySchema`):
 *   agentId?  – optional agent filter
 *   dateFrom  – inclusive UTC day start
 *   dateTo    – inclusive UTC day end
 *   groupBy   – 'day' | 'agent' | 'model'
 *
 * The schema enforces `dateTo >= dateFrom` and a 366-day maximum span
 * to prevent unbounded scans.
 *
 * Authentication: Admin role required. Rate limiting is enforced centrally
 * by `proxy.ts` via the policy table at `lib/security/rate-limit-policy.ts`
 * (orchestration tier — see `.context/security/rate-limiting.md`).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { costBreakdownQuerySchema } from '@/lib/validations/orchestration';
import { getCostBreakdown } from '@/lib/orchestration/llm/cost-reports';

export const GET = withAdminAuth(
  async (request) => {
    const log = await getRouteLogger(request);
    const { searchParams } = new URL(request.url);
    const params = validateQueryParams(searchParams, costBreakdownQuerySchema);

    const breakdown = await getCostBreakdown({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      groupBy: params.groupBy,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });

    log.info('Cost breakdown fetched', {
      groupBy: breakdown.groupBy,
      rowCount: breakdown.rows.length,
      totalCostUsd: breakdown.totals.totalCostUsd,
    });

    return successResponse(breakdown);
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        "Spend records are not personal (`lib/db/owner-classification.ts`): every figure is an aggregate over the entered org's `AiCostLog`, which row isolation bounds to that org.",
    },
  }
);
