'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusIndicator } from './status-indicator';
import { ServiceStatusCard } from './service-status-card';
import { useHealthCheck, type UseHealthCheckOptions } from './use-health-check';
import { formatBytes } from '@/lib/monitoring';
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
 * Format uptime for display
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
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
  title = 'System Status',
  description = 'Current status of all services',
  className,
  ...props
}: StatusPageProps) {
  const hookOptions: UseHealthCheckOptions = {
    pollingInterval,
    onStatusChange,
  };

  const { data, isLoading, error, lastUpdated, refresh, isPolling, startPolling } =
    useHealthCheck(hookOptions);

  // Format last updated time
  const lastUpdatedStr = lastUpdated
    ? lastUpdated.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'Never';

  return (
    <div className={cn('space-y-6', className)} {...props}>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Last updated: {lastUpdatedStr}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-red-500/50 bg-red-50 dark:bg-red-950/20">
          <CardContent className="pt-6">
            <p className="text-red-600 dark:text-red-400">
              Failed to fetch status: {error.message}
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
                  Overall Status
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
                    <p className="text-muted-foreground text-xs">Version</p>
                    <p className="font-mono text-sm">{data.version}</p>
                  </div>
                </div>
                {/* Uptime */}
                <div className="flex items-center gap-2">
                  <Clock className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-muted-foreground text-xs">Uptime</p>
                    <p className="font-mono text-sm">{formatUptime(data.uptime)}</p>
                  </div>
                </div>
                {/* Timestamp */}
                <div className="flex items-center gap-2">
                  <Clock className="text-muted-foreground h-4 w-4" />
                  <div>
                    <p className="text-muted-foreground text-xs">Last Check</p>
                    <p className="font-mono text-sm">
                      {new Date(data.timestamp).toLocaleTimeString()}
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
              Services
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ServiceStatusCard
                name="Database"
                description="PostgreSQL primary database"
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
                  Memory Usage
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground text-xs">Heap Used</p>
                    <p className="font-mono text-sm">{formatBytes(data.memory.heapUsed)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Heap Total</p>
                    <p className="font-mono text-sm">{formatBytes(data.memory.heapTotal)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">RSS</p>
                    <p className="font-mono text-sm">{formatBytes(data.memory.rss)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Usage</p>
                    <p
                      className={cn(
                        'font-mono text-sm',
                        data.memory.percentage > 80 && 'text-yellow-600 dark:text-yellow-400',
                        data.memory.percentage > 90 && 'text-red-600 dark:text-red-400'
                      )}
                    >
                      {data.memory.percentage}%
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
                Auto-refreshing every {pollingInterval / 1000}s
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-gray-400" />
                Auto-refresh paused
                <button onClick={startPolling} className="text-primary hover:underline">
                  Resume
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
