import type { Metadata } from 'next';
import { StatsCards } from '@/components/admin/stats-cards';
import { StatusPage } from '@/components/status/status-page';
import { prisma } from '@/lib/db/client';
import { getDatabaseHealth } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import type { SystemStats } from '@/types/admin';

export const metadata: Metadata = {
  title: 'Overview',
  description: 'Admin dashboard overview',
};

const PROCESS_START_TIME = Date.now();
const APP_VERSION = process.env.npm_package_version || '1.0.0';

function getUptime(): number {
  return Math.floor((Date.now() - PROCESS_START_TIME) / 1000);
}

async function getStats(): Promise<SystemStats | null> {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

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

    const roleCountMap: Record<string, number> = { USER: 0, ADMIN: 0 };
    for (const roleGroup of usersByRole) {
      if (roleGroup.role) {
        roleCountMap[roleGroup.role] = roleGroup._count.role;
      }
    }

    return {
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
        uptime: getUptime(),
        databaseStatus: dbHealth.connected ? 'connected' : 'error',
      },
    };
  } catch (err) {
    logger.error('admin overview page: stats fetch failed', err);
    return null;
  }
}

/**
 * Admin Overview Page (Phase 4.4)
 *
 * Main dashboard with system statistics and status.
 */
export default async function AdminOverviewPage() {
  const stats = await getStats();

  return (
    <div className="space-y-8">
      {/* Stats Cards */}
      <section>
        <h2 className="mb-4 text-lg font-semibold">User Statistics</h2>
        <StatsCards stats={stats} />
      </section>

      {/* System Status */}
      <section>
        <StatusPage
          title="System Status"
          description="Real-time status of all services"
          pollingInterval={30000}
          showMemory={true}
        />
      </section>
    </div>
  );
}
