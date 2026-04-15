import type { Metadata } from 'next';
import { LogsViewer } from '@/components/admin/logs-viewer';
import { getLogEntries } from '@/lib/admin/logs';
import type { PaginationMeta } from '@/types/api';

const DEFAULT_PAGE_LIMIT = 50;

export const metadata: Metadata = {
  title: 'Logs',
  description: 'View application logs',
};

/**
 * Admin Logs Page (Phase 4.4)
 *
 * Application logs viewer with filtering and search.
 */
export default function AdminLogsPage() {
  const { entries: logs, total } = getLogEntries({ limit: DEFAULT_PAGE_LIMIT });
  const meta: PaginationMeta = {
    page: 1,
    limit: DEFAULT_PAGE_LIMIT,
    total,
    totalPages: Math.ceil(total / DEFAULT_PAGE_LIMIT),
  };

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
