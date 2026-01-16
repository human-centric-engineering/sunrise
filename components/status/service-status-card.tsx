'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusIndicator, getStatusConfig } from './status-indicator';
import type { ServiceHealth } from '@/lib/monitoring';

/**
 * Props for ServiceStatusCard component
 */
export interface ServiceStatusCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Name of the service */
  name: string;
  /** Optional description of the service */
  description?: string;
  /** Service health data */
  health: ServiceHealth;
  /** Whether to show latency information */
  showLatency?: boolean;
}

/**
 * Format latency for display
 */
function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${latencyMs}ms`;
  }
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

/**
 * ServiceStatusCard Component
 *
 * Displays the status of an individual service in a card format.
 * Shows status indicator, service name, description, and optional latency.
 *
 * @example
 * ```tsx
 * <ServiceStatusCard
 *   name="Database"
 *   description="PostgreSQL primary database"
 *   health={{
 *     status: 'operational',
 *     connected: true,
 *     latency: 5
 *   }}
 *   showLatency
 * />
 * ```
 */
export function ServiceStatusCard({
  name,
  description,
  health,
  showLatency = true,
  className,
  ...props
}: ServiceStatusCardProps) {
  const statusConfig = getStatusConfig(health.status);

  return (
    <Card
      className={cn(
        'transition-colors',
        health.status === 'outage' && 'border-red-500/50',
        health.status === 'degraded' && 'border-yellow-500/50',
        className
      )}
      {...props}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">{name}</CardTitle>
          <StatusIndicator status={health.status} showLabel />
        </div>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{statusConfig.description}</span>
          {showLatency && health.latency !== undefined && (
            <span
              className={cn(
                'font-mono',
                health.latency > 500
                  ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-muted-foreground'
              )}
            >
              {formatLatency(health.latency)}
            </span>
          )}
        </div>
        {health.error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{health.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
