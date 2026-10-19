import type { Metadata } from 'next';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import { parsePaginationMeta } from '@/lib/validations/common';
import { LogsViewer } from '@/components/admin/logs-viewer';
import type { LogEntry } from '@/types/admin';
import type { PaginationMeta } from '@/types/api';

const DEFAULT_PAGE_LIMIT = 50;

export const metadata: Metadata = {
  title: 'Logs',
  description: 'View application logs',
};

/**
 * Fetch logs from API. A failed load throws to the admin error boundary
 * rather than rendering an empty log (#518).
 */
async function getLogs(): Promise<{
  logs: LogEntry[];
  meta: PaginationMeta;
}> {
  const { data, meta } = await requireServerData<LogEntry[]>(
    API.ADMIN.LOGS + `?limit=${DEFAULT_PAGE_LIMIT}`
  );

  return {
    logs: data,
    meta: parsePaginationMeta(meta) ?? {
      page: 1,
      limit: DEFAULT_PAGE_LIMIT,
      total: data.length,
      totalPages: 1,
    },
  };
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
