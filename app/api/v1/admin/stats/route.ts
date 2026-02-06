/**
 * Admin Stats Endpoint (Phase 4.4)
 *
 * GET /api/v1/admin/stats - Get system statistics for admin dashboard
 *
 * Authentication: Required (Admin role only)
 *
 * Returns:
 *   - User counts (total, by role, recent signups, verified)
 *   - System info (uptime, version, environment)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getDatabaseHealth } from '@/lib/db/utils';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import type { SystemStats } from '@/types/admin';

/**
 * Track the process start time for uptime calculation
 */
const PROCESS_START_TIME = Date.now();

/**
 * Cache the version at module load time
 */
const APP_VERSION = process.env.npm_package_version || '1.0.0';

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

  // Execute all queries in parallel for performance
  const [totalUsers, verifiedUsers, recentSignups, usersByRole, dbHealth] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { emailVerified: true } }),
    prisma.user.count({ where: { createdAt: { gte: twentyFourHoursAgo } } }),
    prisma.user.groupBy({
      by: ['role'],
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
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor((Date.now() - PROCESS_START_TIME) / 1000),
      databaseStatus: dbHealth.connected ? 'connected' : 'error',
    },
  };

  log.info('Admin stats fetched', { userId: session.user.id });

  return successResponse(stats);
});
