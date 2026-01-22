import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { StatsCards } from '@/components/admin/stats-cards';
import { StatusPage } from '@/components/status/status-page';
import type { SystemStats } from '@/types/admin';

export const metadata: Metadata = {
  title: 'Overview',
  description: 'Admin dashboard overview',
};

/**
 * API response type
 */
interface StatsApiResponse {
  success: boolean;
  data: SystemStats;
}

/**
 * Fetch admin stats from API
 */
async function getStats(): Promise<SystemStats | null> {
  try {
    // Get cookies to forward to the API
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const res = await fetch(
      `${process.env.BETTER_AUTH_URL || 'http://localhost:3000'}/api/v1/admin/stats`,
      {
        headers: {
          Cookie: cookieHeader,
        },
        cache: 'no-store',
      }
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as StatsApiResponse;
    return data.success ? data.data : null;
  } catch {
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
