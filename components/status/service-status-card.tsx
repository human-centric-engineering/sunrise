'use client';

import * as React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusIndicator } from '@/components/status/status-indicator';
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
type Formatter = ReturnType<typeof useFormatter>;

/** `250ms`, `1.23s`: the unit's narrow form in the viewer's language. */
function formatLatency(format: Formatter, latencyMs: number): string {
  if (latencyMs < 1000) {
    return format.number(latencyMs, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' });
  }
  return format.number(latencyMs / 1000, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  const t = useTranslations('status.indicator');
  const format = useFormatter();

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
          <span className="text-muted-foreground">{t(`${health.status}.description`)}</span>
          {showLatency && health.latency !== undefined && (
            <span
              className={cn(
                'font-mono',
                health.latency > 500
                  ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-muted-foreground'
              )}
            >
              {formatLatency(format, health.latency)}
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
