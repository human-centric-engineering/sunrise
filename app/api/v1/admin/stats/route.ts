/**
 * Admin Stats Endpoint (Phase 4.4)
 *
 * GET /api/v1/admin/stats - Get system statistics for admin dashboard
 *
 * Authentication: Required (Admin role only)
 *
 * Returns:
 *   - User counts (total, by role, recent signups, verified)
 *   - System info (uptime, app + Sunrise version, node version, environment)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { humanWhere } from '@/lib/auth/account';
import { prisma } from '@/lib/db/client';
import { getDatabaseHealth } from '@/lib/db/utils';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { APP_VERSION } from '@/lib/app-version';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';
import type { SystemStats } from '@/types/admin';

/**
 * Track the process start time for uptime calculation
 */
const PROCESS_START_TIME = Date.now();

// Two versions, owned by different parties. APP_VERSION is the fork's app
// version, derived from package.json via `lib/app-version.ts`; SUNRISE_VERSION
// is the upstream platform release this checkout corresponds to. See
// VERSIONING.md for why they are separate.
//
// This admin-authenticated route is the operator-facing surface for
// SUNRISE_VERSION. It used to be on the unauthenticated `/api/health` payload
// and nowhere an operator could see it — visible to everyone except the person
// who needed it (#531).
//
// It is not the only route that returns the version, and the claim to check
// before adding another is "is it authenticated", not "is it the only one".
// The full set, all authenticated:
//   - here                                        (admin session)
//   - GET/PATCH .../orchestration/mcp/settings    (admin session)
//   - POST /api/v1/mcp `initialize` → serverInfo  (bearer API key, 401 without)
// No unauthenticated surface carries it.

/**
 * GET /api/v1/admin/stats
 *
 * Returns system statistics for the admin dashboard.
 * Includes user counts, role breakdowns, and system health information.
 *
 * @returns SystemStats object
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 */
export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  log.debug('Admin stats requested', { userId: session.user.id });

  // Get 24 hours ago timestamp
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Execute all queries in parallel for performance.
  // All user counts exclude non-login SERVICE principals (the seeded
  // config-owner) via `humanWhere` so the dashboard reflects real people only.
  const [totalUsers, verifiedUsers, recentSignups, usersByRole, dbHealth] = await Promise.all([
    prisma.user.count({ where: humanWhere }),
    prisma.user.count({ where: { ...humanWhere, emailVerified: true } }),
    prisma.user.count({ where: { ...humanWhere, createdAt: { gte: twentyFourHoursAgo } } }),
    prisma.user.groupBy({
      by: ['role'],
      where: humanWhere,
      _count: { role: true },
    }),
    getDatabaseHealth(),
  ]);

  // Convert role counts to object
  const roleCountMap: Record<string, number> = {
    USER: 0,
    ADMIN: 0,
  };

  for (const roleGroup of usersByRole) {
    if (roleGroup.role) {
      roleCountMap[roleGroup.role] = roleGroup._count.role;
    }
  }

  // Build stats response
  const stats: SystemStats = {
    users: {
      total: totalUsers,
      verified: verifiedUsers,
      recentSignups,
      byRole: {
        USER: roleCountMap['USER'] || 0,
        ADMIN: roleCountMap['ADMIN'] || 0,
      },
    },
    system: {
      nodeVersion: process.version,
      appVersion: APP_VERSION,
      sunriseVersion: SUNRISE_VERSION,
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor((Date.now() - PROCESS_START_TIME) / 1000),
      databaseStatus: dbHealth.connected ? 'connected' : 'error',
    },
  };

  log.info('Admin stats fetched', { userId: session.user.id });

  return successResponse(stats);
});
