/**
 * Admin config-health — reports whether operationally-critical settings are configured.
 *
 * GET /api/v1/admin/config-health → ConfigHealthReport
 *
 * Admin-only. **Security:** returns presence booleans only — env-var/secret VALUES are never
 * exposed or logged (mirrors the providers/detect route). Drives the admin dashboard's
 * config-health card + the global critical banner.
 */

import type { NextRequest } from 'next/server';

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { runConfigHealthChecks } from '@/lib/config-health/run';

export const GET = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const report = await runConfigHealthChecks();
  // Counts only — never the checked values.
  log.info('Config health checked', {
    environment: report.environment,
    platform: report.platform,
    ...report.summary,
  });
  return successResponse(report);
});
