import type { Metadata } from 'next';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { StatsCards } from '@/components/admin/stats-cards';
import { SystemInfo } from '@/components/admin/system-info';
import { StatusPage } from '@/components/status/status-page';
import type { SystemStats } from '@/types/admin';

export const metadata: Metadata = {
  title: 'Overview',
  description: 'Admin dashboard overview',
};

/**
 * Admin Overview Page (Phase 4.4)
 *
 * Main dashboard with system statistics and status.
 *
 * The stats are one panel among three, so a failed load does not throw:
 * the stat cards are replaced by a "Couldn't load" notice (`loadServerData`
 * logs the failure), and `SystemInfo` gets `null`, for which it says the
 * stats request failed. The status panel fetches its own data (#518).
 */
export default async function AdminOverviewPage() {
  const result = await loadServerData<SystemStats>(API.ADMIN.STATS);
  const stats = result.ok ? result.data : null;

  return (
    <div className="space-y-8">
      {/* Stats Cards */}
      <section>
        <h2 className="mb-4 text-lg font-semibold">User Statistics</h2>
        {result.ok ? (
          <StatsCards stats={result.data} />
        ) : (
          <LoadFailedNotice what="user statistics" />
        )}
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

      {/* The operator's answer to "which Sunrise is this?" — see SystemInfo */}
      <section>
        <SystemInfo stats={stats} />
      </section>
    </div>
  );
}
