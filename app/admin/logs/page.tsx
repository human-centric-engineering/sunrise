import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { LogsViewer } from '@/components/admin/logs-viewer';
import type { LogEntry } from '@/types/admin';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Logs',
  description: 'View application logs',
};

interface LogsApiResponse {
  success: boolean;
  data: LogEntry[];
  meta?: PaginationMeta;
}

/**
 * Fetch logs from API
 */
async function getLogs(): Promise<{
  logs: LogEntry[];
  meta: PaginationMeta;
}> {
  try {
    // Get cookies to forward to the API
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const res = await fetch(
      `${process.env.BETTER_AUTH_URL || 'http://localhost:3000'}/api/v1/admin/logs?limit=50`,
      {
        headers: {
          Cookie: cookieHeader,
        },
        cache: 'no-store',
      }
    );

    if (!res.ok) {
      return {
        logs: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      };
    }

    const data = (await res.json()) as LogsApiResponse;

    if (!data.success) {
      return {
        logs: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      };
    }

    return {
      logs: data.data,
      meta: data.meta || { page: 1, limit: 50, total: data.data.length, totalPages: 1 },
    };
  } catch {
    return {
      logs: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    };
  }
}

/**
 * Admin Logs Page (Phase 4.4)
 *
 * Application logs viewer with filtering and search.
 */
export default async function AdminLogsPage() {
  const { logs, meta } = await getLogs();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Application Logs</h2>
        <p className="text-muted-foreground text-sm">
          View and filter recent application logs. Logs are stored in memory and reset on server
          restart.
        </p>
      </div>

      <LogsViewer initialLogs={logs} initialMeta={meta} />
    </div>
  );
}
