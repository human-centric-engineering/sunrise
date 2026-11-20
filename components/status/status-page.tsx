'use client';

import * as React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusIndicator } from '@/components/status/status-indicator';
import { ServiceStatusCard } from '@/components/status/service-status-card';
import { useHealthCheck, type UseHealthCheckOptions } from '@/components/status/use-health-check';
import { RefreshCw, Clock, Server, Database, MemoryStick } from 'lucide-react';

/**
 * Props for StatusPage component
 */
export interface StatusPageProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Polling interval in milliseconds (default: 30000 = 30 seconds) */
  pollingInterval?: number;
  /** Whether to show memory stats if available (default: true) */
  showMemory?: boolean;
  /** Callback when status changes */
  onStatusChange?: (status: 'ok' | 'error') => void;
  /** Custom title for the page */
  title?: string;
  /** Custom description */
  description?: string;
}

/**
 * A clock time to the second: the page polls every few seconds, so minutes
 * alone would not show that a refresh happened.
 */
const TIME_WITH_SECONDS = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;

/**
 * Format uptime for display
 */
type Formatter = ReturnType<typeof useFormatter>;

/** `2d 3h 4m 5s`: each unit's narrow form in the viewer's language. */
function formatUptime(format: Formatter, seconds: number): string {
  const units = [
    ['day', Math.floor(seconds / 86400)],
    ['hour', Math.floor((seconds % 86400) / 3600)],
    ['minute', Math.floor((seconds % 3600) / 60)],
    ['second', seconds % 60],
  ] as const;
  const parts = units
    .filter(([unit, n]) => n > 0 || (unit === 'second' && seconds < 60))
    .map(([unit, n]) => format.number(n, { style: 'unit', unit, unitDisplay: 'narrow' }));
  return parts.join(' ');
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * `12.5 MB`, with the unit in the viewer's language. In 1000 steps: Intl's
 * units are the SI ones (it has no kibibyte), so 1024 steps would put a figure
 * about 5% out under the MB label.
 */
function formatMemory(format: Formatter, bytes: number): string {
  const i = bytes > 0 ? Math.min(Math.floor(Math.log10(bytes) / 3), BYTE_UNITS.length - 1) : 0;
  return format.number(bytes / Math.pow(1000, i), {
    style: 'unit',
    unit: BYTE_UNITS[i],
    unitDisplay: 'short',
    maximumFractionDigits: 2,
  });
}

/**
 * StatusPage Component
 *
 * Main status page component that displays overall system health,
 * individual service statuses, and optional memory information.
 *
 * @example
 * ```tsx
 * // Basic usage - polls /api/health every 30 seconds
 * <StatusPage />
 *
 * // With custom options
 * <StatusPage
 *   pollingInterval={60000}
 *   showMemory={true}
 *   onStatusChange={(status) => console.log('Status changed:', status)}
 *   title="System Status"
 *   description="Real-time status of all services"
 * />
 * ```
 */
export function StatusPage({
  pollingInterval = 30000,
  showMemory = true,
  onStatusChange,
  title,
  description,
  className,
  ...props
}: StatusPageProps) {
  const hookOptions: UseHealthCheckOptions = {
    pollingInterval,
    onStatusChange,
  };

  const t = useTranslations('status.page');
  const format = useFormatter();

  const { data, isLoading, error, lastUpdated, refresh, isPolling, startPolling } =
    useHealthCheck(hookOptions);

  // Format last updated time
  const lastUpdatedStr = lastUpdated ? format.dateTime(lastUpdated, TIME_WITH_SECONDS) : t('never');

  return (
    <div className={cn('space-y-6', className)} {...props}>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title ?? t('title')}</h1>
          <p className="text-muted-foreground text-sm">{description ?? t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {t('lastUpdated', { time: lastUpdatedStr })}
          </span>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-red-500/50 bg-red-50 dark:bg-red-950/20">
          <CardContent className="pt-6">
            <p className="text-red-600 dark:text-red-400">
              {t('fetchFailed', { message: error.message })}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && !data && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      )}

      {/* Main content */}
      {data && (
        <>
          {/* Overall status */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5" />
                  {t('overallStatus')}
                </CardTitle>
                <StatusIndicator
                  status={data.status === 'ok' ? 'operational' : 'outage'}
                  showLabel
                  size="lg"
                  animate={data.status === 'ok'}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                {/* Version */}
                <div className="flex items-center gap-2">
                  <Server className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-muted-foreground text-xs">{t('version')}</p>
                    <p className="font-mono text-sm">{data.version}</p>
                  </div>
                </div>
                {/* Uptime */}
                <div className="flex items-center gap-2">
                  <Clock className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-muted-foreground text-xs">{t('uptime')}</p>
                    <p className="font-mono text-sm">{formatUptime(format, data.uptime)}</p>
                  </div>
                </div>
                {/* Timestamp */}
                <div className="flex items-center gap-2">
                  <Clock className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-muted-foreground text-xs">{t('lastCheck')}</p>
                    <p className="font-mono text-sm">
                      {format.dateTime(new Date(data.timestamp), TIME_WITH_SECONDS)}
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Services */}
          <div className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Database className="h-5 w-5" />
              {t('services')}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ServiceStatusCard
                name={t('database')}
                description={t('databaseDescription')}
                health={data.services.database}
                showLatency
              />
            </div>
          </div>

          {/* Memory (optional) */}
          {showMemory && data.memory && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MemoryStick className="h-5 w-5" />
                  {t('memoryUsage')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground text-xs">{t('heapUsed')}</p>
                    <p className="font-mono text-sm">
                      {formatMemory(format, data.memory.heapUsed)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">{t('heapTotal')}</p>
                    <p className="font-mono text-sm">
                      {formatMemory(format, data.memory.heapTotal)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">{t('rss')}</p>
                    <p className="font-mono text-sm">{formatMemory(format, data.memory.rss)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">{t('usage')}</p>
                    <p
                      className={cn(
                        'font-mono text-sm',
                        data.memory.percentage > 80 && 'text-yellow-600 dark:text-yellow-400',
                        data.memory.percentage > 90 && 'text-red-600 dark:text-red-400'
                      )}
                    >
                      {format.number(data.memory.percentage / 100, 'percent')}
                    </p>
                  </div>
                </div>
                {/* Memory bar */}
                <div className="mt-4">
                  <div className="bg-secondary h-2 w-full overflow-hidden rounded-full">
                    <div
                      className={cn(
                        'h-full transition-all duration-500',
                        data.memory.percentage <= 70 && 'bg-green-500',
                        data.memory.percentage > 70 &&
                          data.memory.percentage <= 85 &&
                          'bg-yellow-500',
                        data.memory.percentage > 85 && 'bg-red-500'
                      )}
                      style={{ width: `${data.memory.percentage}%` }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Polling status */}
          <div className="text-muted-foreground flex items-center justify-center gap-2 text-xs">
            {isPolling ? (
              <>
                <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                {t('autoRefreshing', { seconds: pollingInterval / 1000 })}
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-gray-400" />
                {t('autoRefreshPaused')}
                <button onClick={startPolling} className="text-primary hover:underline">
                  {t('resume')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
