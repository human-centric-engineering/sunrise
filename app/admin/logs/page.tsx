import type { Metadata } from 'next';
import { serverFetch } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { LogsViewer } from '@/components/admin/logs-viewer';
import type { LogEntry, LogsResponse } from '@/types/admin';
import type { PaginationMeta } from '@/types/api';

const DEFAULT_PAGE_LIMIT = 50;

export const metadata: Metadata = {
  title: 'Logs',
  description: 'View application logs',
};

/**
 * Fetch logs from API
 */
async function getLogs(): Promise<{
  logs: LogEntry[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(API.ADMIN.LOGS + `?limit=${DEFAULT_PAGE_LIMIT}`);

    if (!res.ok) {
      return {
        logs: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    const data = (await res.json()) as LogsResponse;

    if (!data.success) {
      return {
        logs: [],
        meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
      };
    }

    return {
      logs: data.data,
      meta: data.meta || {
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        total: data.data.length,
        totalPages: 1,
      },
    };
  } catch {
    return {
      logs: [],
      meta: { page: 1, limit: DEFAULT_PAGE_LIMIT, total: 0, totalPages: 0 },
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
