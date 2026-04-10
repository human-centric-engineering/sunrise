/**
 * Admin Orchestration — Budget alerts
 *
 * GET /api/v1/admin/orchestration/costs/alerts
 *
 * Returns every agent with a `monthlyBudgetUsd` whose month-to-date
 * utilisation is at or above 80%. Severity is `warning` between 0.8
 * and 1.0 and `critical` at 1.0 or above. Agents below 0.8 and agents
 * without a budget are omitted entirely.
 *
 * Admin-global (not user-scoped).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getBudgetAlerts } from '@/lib/orchestration/llm/cost-reports';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const alerts = await getBudgetAlerts();
  log.info('Budget alerts fetched', {
    total: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
  });
  return successResponse({ alerts });
});
