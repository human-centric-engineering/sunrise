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
 * Admin-global (not user-scoped). `globalCap.spent` is every org's spend, so
 * it is `null` unless the caller is in the install org (`getGlobalCapStatus`).
 *
 * Org-tier (§111 t-812): an org admin gets their org's agents' alerts, and of
 * the global cap only whether it is exceeded, since it refuses their org's
 * paid calls too. The cap itself is the platform's budget setting, so it is
 * `null` for them as `spent` already is.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { getBudgetAlerts, getGlobalCapStatus } from '@/lib/orchestration/llm/cost-reports';

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const [alerts, capStatus, platform] = await Promise.all([
      getBudgetAlerts(),
      getGlobalCapStatus(),
      administersPlatform(session.principal),
    ]);
    const globalCap = platform ? capStatus : { ...capStatus, cap: null, spent: null };
    log.info('Budget alerts fetched', {
      total: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      globalCapExceeded: globalCap.exceeded,
    });
    return successResponse({ alerts, globalCap });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        "Agents and their spend are org records, not anyone's personal rows; row isolation bounds both to the entered org, and the cross-org global cap figures go to a platform admin only.",
    },
  }
);
