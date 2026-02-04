'use client';

/**
 * Logs Viewer Component (Phase 4.4)
 *
 * Displays application logs with filtering, search, and pagination.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ClientDate } from '@/components/ui/client-date';
import type { LogEntry } from '@/types/admin';
import type { PaginationMeta } from '@/types/api';
import { parseApiResponse } from '@/lib/api/parse-response';
import { API } from '@/lib/api/endpoints';

interface LogsViewerProps {
  initialLogs: LogEntry[];
  initialMeta: PaginationMeta;
}

/**
 * Get badge variant and icon for log level
 */
function getLevelConfig(level: string): {
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  icon: React.ReactNode;
  className: string;
} {
  switch (level) {
    case 'error':
      return {
        variant: 'destructive',
        icon: <AlertCircle className="h-3 w-3" />,
        className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
      };
    case 'warn':
      return {
        variant: 'secondary',
        icon: <AlertTriangle className="h-3 w-3" />,
        className: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
      };
    case 'info':
      return {
        variant: 'outline',
        icon: <Info className="h-3 w-3" />,
        className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      };
    case 'debug':
    default:
      return {
        variant: 'outline',
        icon: <Bug className="h-3 w-3" />,
        className: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20',
      };
  }
}

/**
 * Single log entry component
 */
function LogEntryItem({ entry }: { entry: LogEntry }) {
  const levelConfig = getLevelConfig(entry.level);
  // Check for actual content, not just property existence
  const hasContext = entry.context && Object.keys(entry.context).length > 0;
  const hasMeta = entry.meta && Object.keys(entry.meta).length > 0;
  const hasError = !!entry.error;
  const hasDetails = hasContext || hasMeta || hasError;

  // Shared content for the log entry row
  const entryContent = (
    <div className="flex w-full items-start gap-3 text-left">
      <Badge
        variant={levelConfig.variant}
        className={cn('flex shrink-0 items-center gap-1', levelConfig.className)}
      >
        {levelConfig.icon}
        {entry.level.toUpperCase()}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.message}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          <ClientDate date={entry.timestamp} showTime />
        </p>
      </div>
    </div>
  );

  // If no details, render without accordion trigger (no chevron)
  if (!hasDetails) {
    return <div className="border-b px-4 py-3 last:border-b-0">{entryContent}</div>;
  }

  return (
    <AccordionItem value={entry.id} className="border-b last:border-b-0">
      <AccordionTrigger className="px-4 py-3 hover:no-underline">{entryContent}</AccordionTrigger>
      <AccordionContent className="px-4 pb-4">
        <div className="space-y-3 text-sm">
          {hasContext && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">Context:</p>
              <pre className="bg-muted overflow-x-auto rounded-md p-2 text-xs">
                {JSON.stringify(entry.context, null, 2)}
              </pre>
            </div>
          )}
          {hasMeta && (
            <div>
              <p className="text-muted-foreground mb-1 text-xs font-medium">Metadata:</p>
              <pre className="bg-muted overflow-x-auto rounded-md p-2 text-xs">
                {JSON.stringify(entry.meta, null, 2)}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <p className="mb-1 text-xs font-medium text-red-600 dark:text-red-400">Error:</p>
              <div className="rounded-md bg-red-50 p-2 text-xs dark:bg-red-950/20">
                <p className="font-medium">
                  {entry.error!.name}: {entry.error!.message}
                </p>
                {entry.error!.code && (
                  <p className="text-muted-foreground">Code: {entry.error!.code}</p>
                )}
                {entry.error!.stack && (
                  <pre className="mt-2 overflow-x-auto text-red-600/80 dark:text-red-400/80">
                    {entry.error!.stack}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function LogsViewer({ initialLogs, initialMeta }: LogsViewerProps) {
  const [logs, setLogs] = useState(initialLogs);
  const [meta, setMeta] = useState(initialMeta);
  const [level, setLevel] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch logs with current filters
   */
  const fetchLogs = useCallback(
    async (page = 1, overrides?: { search?: string; level?: string }) => {
      setIsLoading(true);
      try {
        // Build URL with params
        // Use overrides if provided (from handlers), otherwise use state
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const levelValue = overrides?.level !== undefined ? overrides.level : level;
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
        });
        if (levelValue !== 'all') params.set('level', levelValue);
        if (searchValue) params.set('search', searchValue);

        const res = await fetch(`${API.ADMIN.LOGS}?${params.toString()}`, {
          credentials: 'same-origin',
        });

        if (!res.ok) {
          throw new Error('Failed to fetch logs');
        }

        const response = await parseApiResponse<LogEntry[]>(res);

        if (!response.success) {
          throw new Error('Failed to fetch logs');
        }

        setLogs(response.data);
        if (response.meta) {
          setMeta(response.meta as PaginationMeta);
        }
      } catch {
        // Error is silently caught — Batch 6 will add proper error state UI
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, level, search]
  );

  /**
   * Handle level filter change
   */
  const handleLevelChange = useCallback(
    (value: string) => {
      setLevel(value);
      // Pass level directly to avoid stale closure issue
      void fetchLogs(1, { level: value });
    },
    [fetchLogs]
  );

  /**
   * Handle search input with debouncing
   */
  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);

      // Clear previous timeout to debounce
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // Set new timeout - 300ms balances responsiveness with server load
      // Pass value directly to avoid stale closure issue
      searchTimeoutRef.current = setTimeout(() => {
        void fetchLogs(1, { search: value });
      }, 300);
    },
    [fetchLogs]
  );

  /**
   * Handle pagination
   */
  const handlePageChange = useCallback(
    (page: number) => {
      void fetchLogs(page);
    },
    [fetchLogs]
  );

  /**
   * Auto-refresh effect
   */
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      void fetchLogs(meta.page);
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs, meta.page]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search logs..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={level} onValueChange={handleLevelChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Filter level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warn">Warning</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchLogs(meta.page)}
            disabled={isLoading}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? 'Stop' : 'Auto-refresh'}
          </Button>
        </div>
      </div>

      {/* Logs List */}
      <Card>
        <CardContent className="p-0">
          {isLoading && logs.length === 0 ? (
            <div className="flex h-48 items-center justify-center">
              <RefreshCw className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center">
              <Info className="text-muted-foreground mb-2 h-8 w-8" />
              <p className="text-muted-foreground text-sm">No logs found</p>
              <p className="text-muted-foreground text-xs">
                {search || level !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Logs will appear as the application runs'}
              </p>
            </div>
          ) : (
            <Accordion type="multiple" className="w-full">
              {logs.map((entry) => (
                <LogEntryItem key={entry.id} entry={entry} />
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {logs.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            Showing {(meta.page - 1) * meta.limit + 1} to{' '}
            {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} logs
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(meta.page - 1)}
              disabled={meta.page <= 1 || isLoading}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(meta.page + 1)}
              disabled={meta.page >= meta.totalPages || isLoading}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Auto-refresh status */}
      {autoRefresh && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 text-xs">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
          Auto-refreshing every 5 seconds
        </div>
      )}
    </div>
  );
}
